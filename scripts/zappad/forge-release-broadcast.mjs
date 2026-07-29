import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROBINHOOD_RPC_ALIAS = "robinhood";
const BLOCKSCOUT_VERIFIER_URL = "https://robinhoodchain.blockscout.com/api/";

export const RELEASE_ACTIONS = Object.freeze({
  "deploy-safe": Object.freeze({
    target:
      "contracts/zappad/script/DeploySafeTreasury.s.sol:DeploySafeTreasury",
    requireSlow: false,
    requireVerification: false,
    senderEnv: "DEPLOYER_ADDRESS",
  }),
  "deploy-stack": Object.freeze({
    target: "contracts/zappad/script/DeployZapPad.s.sol:DeployZapPad",
    requireSlow: false,
    requireVerification: true,
    senderEnv: "DEPLOYER_ADDRESS",
  }),
  "prepare-canaries": Object.freeze({
    target:
      "contracts/zappad/script/PrepareZapPadCanaries.s.sol:PrepareZapPadCanaries",
    requireSlow: true,
    requireVerification: false,
    senderEnv: "CANARY_CREATOR",
  }),
  "cleanup-canaries": Object.freeze({
    target:
      "contracts/zappad/script/CleanupCanaryAllowances.s.sol:CleanupCanaryAllowances",
    requireSlow: true,
    requireVerification: false,
    senderEnv: "CANARY_CREATOR",
  }),
});

const VALUE_FLAGS = new Set([
  "--rpc-url",
  "--account",
  "--sender",
  "--verifier",
  "--verifier-url",
]);
const BOOLEAN_FLAGS = new Set(["--broadcast", "--slow", "--verify"]);
const FORBIDDEN_FLAGS = new Set([
  "--resume",
  "--unlocked",
  "--private-key",
  "--private-keys",
  "--mnemonic",
  "--mnemonic-passphrase",
  "--mnemonic-derivation-path",
  "--mnemonic-indexes",
  "--password",
  "--keystore",
  "--skip-simulation",
  "--sig",
  "--target-contract",
  "--root",
]);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_ENV_PREFIXES = ["FOUNDRY_", "DAPP_"];

function fail(message) {
  throw new Error(message);
}

function parseFlag(token) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) return { name: token, inlineValue: undefined };
  return {
    name: token.slice(0, equalsIndex),
    inlineValue: token.slice(equalsIndex + 1),
  };
}

function requireSingleFlag(values, name) {
  const entries = values.get(name) ?? [];
  if (entries.length !== 1) {
    fail(`${name} must be supplied exactly once`);
  }
  return entries[0];
}

function rejectFoundryEnvironmentOverrides(env) {
  const override = Object.keys(env).find((name) =>
    FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  if (override) {
    fail(
      `${override} is not allowed for a release broadcast; Foundry configuration must come from the reviewed checkout`,
    );
  }
}

export function buildForgeReleaseInvocation(argv, env = process.env) {
  const [actionName, ...rawArgs] = argv;
  const action = RELEASE_ACTIONS[actionName];
  if (!action) fail("Unknown Forge release action");
  rejectFoundryEnvironmentOverrides(env);
  if (
    typeof env.ROBINHOOD_RPC_URL !== "string" ||
    env.ROBINHOOD_RPC_URL.length === 0
  ) {
    fail("ROBINHOOD_RPC_URL is required");
  }
  let parsedRpcUrl;
  try {
    parsedRpcUrl = new URL(env.ROBINHOOD_RPC_URL);
  } catch {
    fail("ROBINHOOD_RPC_URL must be a valid HTTPS URL");
  }
  if (parsedRpcUrl.protocol !== "https:") {
    fail("ROBINHOOD_RPC_URL must be a valid HTTPS URL");
  }

  const forgeArgs = [];
  const values = new Map();
  const seenBoolean = new Set();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--") continue;
    if (/^-v{1,5}$/.test(token)) {
      forgeArgs.push(token);
      continue;
    }
    if (!token.startsWith("--")) {
      fail("Unexpected positional Forge argument");
    }

    const { name, inlineValue } = parseFlag(token);
    if (FORBIDDEN_FLAGS.has(name)) {
      fail(`Forbidden Forge argument: ${name}`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        fail(`Boolean Forge argument cannot have a value: ${name}`);
      }
      if (seenBoolean.has(name)) fail(`Duplicate Forge argument: ${name}`);
      seenBoolean.add(name);
      forgeArgs.push(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      fail(`Forge argument is not allowlisted: ${name}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      value = rawArgs[index];
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("-")
    ) {
      fail(`Forge argument requires a value: ${name}`);
    }
    const existing = values.get(name) ?? [];
    if (existing.length > 0) fail(`Duplicate Forge argument: ${name}`);
    values.set(name, [value]);
    forgeArgs.push(name, value);
  }

  const rpcAlias = requireSingleFlag(values, "--rpc-url");
  if (rpcAlias !== ROBINHOOD_RPC_ALIAS) {
    fail("--rpc-url must use the robinhood Foundry alias");
  }
  const account = requireSingleFlag(values, "--account");
  if (!ACCOUNT_PATTERN.test(account)) {
    fail("--account must name an encrypted Foundry keystore account");
  }
  const sender = requireSingleFlag(values, "--sender");
  if (!ADDRESS_PATTERN.test(sender)) {
    fail("--sender must be an address");
  }
  const expectedSender = env[action.senderEnv];
  if (
    typeof expectedSender !== "string" ||
    !ADDRESS_PATTERN.test(expectedSender)
  ) {
    fail(`${action.senderEnv} must be an address`);
  }
  if (sender.toLowerCase() !== expectedSender.toLowerCase()) {
    fail(`--sender must match ${action.senderEnv}`);
  }
  if (!seenBoolean.has("--broadcast")) {
    fail("--broadcast is required");
  }
  if (seenBoolean.has("--slow") !== action.requireSlow) {
    fail(
      action.requireSlow
        ? "--slow is required for this release action"
        : "--slow is not allowed for this release action",
    );
  }
  if (seenBoolean.has("--verify") !== action.requireVerification) {
    fail(
      action.requireVerification
        ? "--verify is required for the stack deployment"
        : "--verify is not allowed for this release action",
    );
  }
  if (action.requireVerification) {
    if (requireSingleFlag(values, "--verifier") !== "blockscout") {
      fail("--verifier must be blockscout");
    }
    if (
      requireSingleFlag(values, "--verifier-url") !== BLOCKSCOUT_VERIFIER_URL
    ) {
      fail("--verifier-url must use the canonical Robinhood Blockscout API");
    }
  } else if (
    values.has("--verifier") ||
    values.has("--verifier-url")
  ) {
    fail("Verification arguments are only allowed for the stack deployment");
  }

  return {
    actionName,
    forgeArgs: [
      "script",
      "--root",
      "contracts/zappad",
      action.target,
      "--force",
      ...forgeArgs,
    ],
  };
}

export async function spawnForgeRelease(
  forgeArgs,
  { repositoryRoot = REPOSITORY_ROOT, env = process.env } = {},
) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("forge", forgeArgs, {
      cwd: repositoryRoot,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", () => {
      rejectPromise(new Error("Unable to start the Forge release broadcast"));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          signal
            ? "Forge release broadcast was terminated"
            : `Forge release broadcast failed with exit code ${String(code)}`,
        ),
      );
    });
  });
}

export async function runForgeReleaseBroadcast(
  argv,
  {
    repositoryRoot = REPOSITORY_ROOT,
    env = process.env,
    verifyCheckout = verifyReleaseCheckout,
    spawnForge = spawnForgeRelease,
  } = {},
) {
  const invocation = buildForgeReleaseInvocation(argv, env);
  const expectedCommit = env.EXPECTED_RELEASE_COMMIT;
  await verifyCheckout(expectedCommit, { repositoryRoot });
  await spawnForge(invocation.forgeArgs, { repositoryRoot, env });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runForgeReleaseBroadcast(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Release broadcast failed");
    process.exitCode = 1;
  });
}
