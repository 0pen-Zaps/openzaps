import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseCheckout } from "./release-checkout.mjs";

const execFileAsync = promisify(execFile);
const temporaryRepositories = [];

async function command(repositoryRoot, commandName, args) {
  return execFileAsync(commandName, args, { cwd: repositoryRoot });
}

async function repository() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "zappad-release-checkout-"));
  temporaryRepositories.push(repositoryRoot);
  await command(repositoryRoot, "git", ["init", "--quiet"]);
  await command(repositoryRoot, "git", ["config", "user.name", "ZapPad Test"]);
  await command(repositoryRoot, "git", [
    "config",
    "user.email",
    "zappad-test@example.invalid",
  ]);
  await writeFile(
    join(repositoryRoot, ".gitignore"),
    ".env*\n!.env.example\ndeployments/zappad/release-evidence/\n",
  );
  await writeFile(join(repositoryRoot, "release.txt"), "reviewed\n");
  await command(repositoryRoot, "git", ["add", ".gitignore", "release.txt"]);
  await command(repositoryRoot, "git", ["commit", "--quiet", "-m", "reviewed"]);
  const { stdout } = await command(repositoryRoot, "git", ["rev-parse", "HEAD"]);
  return { repositoryRoot, commit: stdout.trim() };
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("release checkout verification", () => {
  it("accepts an exact clean checkout", async () => {
    const { repositoryRoot, commit } = await repository();

    await expect(
      verifyReleaseCheckout(commit, { repositoryRoot }),
    ).resolves.toBeUndefined();
  });

  it("rejects standard untracked files even when tracked files match HEAD", async () => {
    const { repositoryRoot, commit } = await repository();
    await writeFile(join(repositoryRoot, "untracked-source.ts"), "export {};\n");

    await expect(
      verifyReleaseCheckout(commit, { repositoryRoot }),
    ).rejects.toThrow("Untracked release files are present");
  });

  it("rejects ignored root environment files that can alter a local build", async () => {
    const { repositoryRoot, commit } = await repository();
    await writeFile(
      join(repositoryRoot, ".env.production.local"),
      "NEXT_PUBLIC_APP_URL=https://wrong.example\n",
    );

    await expect(
      verifyReleaseCheckout(commit, { repositoryRoot }),
    ).rejects.toThrow("Ignored root environment files are present");
  });

  it("allows the ignored Foundry evidence bridge", async () => {
    const { repositoryRoot, commit } = await repository();
    const bridge = join(
      repositoryRoot,
      "deployments",
      "zappad",
      "release-evidence",
    );
    await mkdir(bridge, { recursive: true });
    await writeFile(join(bridge, "approved.json"), '{"ok":true}\n');

    await expect(
      verifyReleaseCheckout(commit, { repositoryRoot }),
    ).resolves.toBeUndefined();
  });
});
