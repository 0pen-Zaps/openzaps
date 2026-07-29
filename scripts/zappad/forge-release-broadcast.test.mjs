import { execFile } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildForgeReleaseInvocation,
  runForgeReleaseBroadcast,
} from "./forge-release-broadcast.mjs";

const execFileAsync = promisify(execFile);
const temporaryRepositories = [];
const SENDER = "0x5a52D4B820Ae7F02880d270562950918ACb14aA2";
const CANARY_SENDER = "0x1111111111111111111111111111111111111111";
const BASE_ENV = Object.freeze({
  CANARY_CREATOR: CANARY_SENDER,
  DEPLOYER_ADDRESS: SENDER.toLowerCase(),
  EXPECTED_RELEASE_COMMIT: "a".repeat(40),
  ROBINHOOD_RPC_URL: "https://rpc.example.invalid",
});

async function command(repositoryRoot, commandName, args) {
  return execFileAsync(commandName, args, { cwd: repositoryRoot });
}

async function repository() {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "zappad-forge-release-broadcast-"),
  );
  temporaryRepositories.push(repositoryRoot);
  await command(repositoryRoot, "git", ["init", "--quiet"]);
  await command(repositoryRoot, "git", ["config", "user.name", "ZapPad Test"]);
  await command(repositoryRoot, "git", [
    "config",
    "user.email",
    "zappad-test@example.invalid",
  ]);
  await writeFile(join(repositoryRoot, ".gitignore"), ".env*\n");
  await writeFile(join(repositoryRoot, "release.txt"), "reviewed\n");
  await command(repositoryRoot, "git", ["add", ".gitignore", "release.txt"]);
  await command(repositoryRoot, "git", ["commit", "--quiet", "-m", "reviewed"]);
  const { stdout } = await command(repositoryRoot, "git", ["rev-parse", "HEAD"]);
  return { repositoryRoot, commit: stdout.trim() };
}

function safeArgs(...extra) {
  return [
    "deploy-safe",
    "--rpc-url",
    "robinhood",
    "--account",
    "nodar-deployer",
    "--sender",
    SENDER,
    "--broadcast",
    ...extra,
  ];
}

function stackArgs(...extra) {
  return [
    "deploy-stack",
    "--rpc-url",
    "robinhood",
    "--account",
    "nodar-deployer",
    "--sender",
    SENDER,
    "--broadcast",
    "--verify",
    "--verifier",
    "blockscout",
    "--verifier-url",
    "https://robinhoodchain.blockscout.com/api/",
    ...extra,
  ];
}

function canaryArgs(action = "prepare-canaries", ...extra) {
  return [
    action,
    "--rpc-url",
    "robinhood",
    "--account",
    "canary-creator",
    "--sender",
    CANARY_SENDER,
    "--broadcast",
    ...extra,
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("canonical Forge release broadcast", () => {
  it("checks the release checkout before spawning one exact allowlisted target", async () => {
    const events = [];
    const env = { ...BASE_ENV };

    await runForgeReleaseBroadcast(safeArgs("-vvvv"), {
      repositoryRoot: "/reviewed/zappad",
      env,
      verifyCheckout: async (commit, options) => {
        events.push(["verify", commit, options]);
      },
      spawnForge: async (args, options) => {
        events.push(["spawn", args, options]);
      },
    });

    expect(events[0]).toEqual([
      "verify",
      BASE_ENV.EXPECTED_RELEASE_COMMIT,
      { repositoryRoot: "/reviewed/zappad" },
    ]);
    expect(events[1]).toEqual([
      "spawn",
      [
        "script",
        "--root",
        "contracts/zappad",
        "contracts/zappad/script/DeploySafeTreasury.s.sol:DeploySafeTreasury",
        "--force",
        "--rpc-url",
        "robinhood",
        "--account",
        "nodar-deployer",
        "--sender",
        SENDER,
        "--broadcast",
        "-vvvv",
      ],
      { repositoryRoot: "/reviewed/zappad", env },
    ]);
  });

  it("allows only the canonical verified ZapPad stack target", () => {
    const invocation = buildForgeReleaseInvocation(stackArgs(), BASE_ENV);
    expect(invocation.forgeArgs.slice(0, 4)).toEqual([
      "script",
      "--root",
      "contracts/zappad",
      "contracts/zappad/script/DeployZapPad.s.sol:DeployZapPad",
    ]);
    expect(invocation.forgeArgs[4]).toBe("--force");
    expect(invocation.forgeArgs).toContain("--verify");
    expect(invocation.forgeArgs).toContain("blockscout");
  });

  it("requires broadcast and slow mode for stateful canary actions", () => {
    expect(() =>
      buildForgeReleaseInvocation(
        safeArgs().filter((value) => value !== "--broadcast"),
        BASE_ENV,
      ),
    ).toThrow("--broadcast is required");

    const canaryWithoutSlow = canaryArgs();
    expect(() =>
      buildForgeReleaseInvocation(canaryWithoutSlow, BASE_ENV),
    ).toThrow("--slow is required");
    expect(() =>
      buildForgeReleaseInvocation(
        [...canaryWithoutSlow, "--slow"],
        BASE_ENV,
      ),
    ).not.toThrow();
  });

  it("binds the sender to the action-specific ceremony identity", () => {
    expect(() =>
      buildForgeReleaseInvocation(
        safeArgs(),
        { ...BASE_ENV, DEPLOYER_ADDRESS: CANARY_SENDER },
      ),
    ).toThrow("--sender must match DEPLOYER_ADDRESS");
    expect(() =>
      buildForgeReleaseInvocation(
        canaryArgs("cleanup-canaries", "--slow"),
        { ...BASE_ENV, CANARY_CREATOR: SENDER },
      ),
    ).toThrow("--sender must match CANARY_CREATOR");
    expect(() =>
      buildForgeReleaseInvocation(safeArgs(), BASE_ENV),
    ).not.toThrow();
  });

  it("pins the RPC argument to the robinhood alias and keeps the secret in env", () => {
    expect(() =>
      buildForgeReleaseInvocation(
        safeArgs().map((value) =>
          value === "robinhood" ? BASE_ENV.ROBINHOOD_RPC_URL : value,
        ),
        BASE_ENV,
      ),
    ).toThrow("must use the robinhood Foundry alias");
    expect(() =>
      buildForgeReleaseInvocation(safeArgs(), {
        ...BASE_ENV,
        ROBINHOOD_RPC_URL: "http://insecure.example.invalid",
      }),
    ).toThrow("valid HTTPS URL");
  });

  it.each([
    ["FOUNDRY_REMAPPINGS", "@openzeppelin/=/tmp/unreviewed/"],
    ["FOUNDRY_SOLC", "/tmp/unreviewed-solc"],
    ["FOUNDRY_LIBS", '["/tmp/unreviewed-libs"]'],
    ["FOUNDRY_PROFILE", "unreviewed"],
    ["FOUNDRY_CONFIG", "/tmp/unreviewed-foundry.toml"],
    ["FOUNDRY_ETH_RPC_URL", "https://unreviewed-rpc.example.invalid"],
    ["DAPP_REMAPPINGS", "@openzeppelin/=/tmp/unreviewed/"],
    ["DAPP_SOLC", "/tmp/unreviewed-solc"],
  ])("rejects inherited release configuration before checkout or spawn: %s", async (name, value) => {
    let checkoutCalls = 0;
    let spawnCalls = 0;
    const operation = runForgeReleaseBroadcast(safeArgs(), {
      env: { ...BASE_ENV, [name]: value },
      verifyCheckout: async () => {
        checkoutCalls += 1;
      },
      spawnForge: async () => {
        spawnCalls += 1;
      },
    });

    await expect(operation).rejects.toThrow(
      `${name} is not allowed for a release broadcast`,
    );
    expect(checkoutCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  it.each([
    ["--resume"],
    ["--unlocked"],
    ["--private-key", "0xraw-secret-value"],
    ["--mnemonic", "raw seed words"],
    ["--skip-simulation"],
    ["--sig", "attacker()"],
    ["--force"],
    ["contracts/zappad/script/Attacker.s.sol:Attacker"],
  ])("rejects forbidden arguments before checkout or spawn: %s", async (...extra) => {
    let checkoutCalls = 0;
    let spawnCalls = 0;
    const operation = runForgeReleaseBroadcast(safeArgs(...extra), {
      env: BASE_ENV,
      verifyCheckout: async () => {
        checkoutCalls += 1;
      },
      spawnForge: async () => {
        spawnCalls += 1;
      },
    });

    await expect(operation).rejects.toThrow();
    await operation.catch((error) => {
      expect(error.message).not.toContain("0xraw-secret-value");
      expect(error.message).not.toContain("raw seed words");
    });
    expect(checkoutCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  it("stops a mismatched HEAD before spawning Forge", async () => {
    const { repositoryRoot } = await repository();
    let spawnCalls = 0;

    await expect(
      runForgeReleaseBroadcast(safeArgs(), {
        repositoryRoot,
        env: BASE_ENV,
        spawnForge: async () => {
          spawnCalls += 1;
        },
      }),
    ).rejects.toThrow("does not match the current checkout");
    expect(spawnCalls).toBe(0);
  });

  it("stops tracked drift before spawning Forge", async () => {
    const { repositoryRoot, commit } = await repository();
    await appendFile(join(repositoryRoot, "release.txt"), "dirty\n");
    let spawnCalls = 0;

    await expect(
      runForgeReleaseBroadcast(safeArgs(), {
        repositoryRoot,
        env: { ...BASE_ENV, EXPECTED_RELEASE_COMMIT: commit },
        spawnForge: async () => {
          spawnCalls += 1;
        },
      }),
    ).rejects.toThrow("Tracked release files differ");
    expect(spawnCalls).toBe(0);
  });

  it("stops standard untracked files before spawning Forge", async () => {
    const { repositoryRoot, commit } = await repository();
    await writeFile(join(repositoryRoot, "unreviewed.sol"), "contract Bad {}\n");
    let spawnCalls = 0;

    await expect(
      runForgeReleaseBroadcast(safeArgs(), {
        repositoryRoot,
        env: { ...BASE_ENV, EXPECTED_RELEASE_COMMIT: commit },
        spawnForge: async () => {
          spawnCalls += 1;
        },
      }),
    ).rejects.toThrow("Untracked release files are present");
    expect(spawnCalls).toBe(0);
  });
});
