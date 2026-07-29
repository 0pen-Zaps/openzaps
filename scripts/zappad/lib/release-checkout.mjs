import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export async function verifyReleaseCheckout(
  expectedCommit,
  { repositoryRoot = REPOSITORY_ROOT } = {},
) {
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error("EXPECTED_RELEASE_COMMIT must be a full Git commit");
  }

  let currentCommit;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
    });
    currentCommit = result.stdout.trim();
  } catch {
    throw new Error("Unable to resolve the current Git release commit");
  }
  if (currentCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error("EXPECTED_RELEASE_COMMIT does not match the current checkout");
  }

  try {
    await execFileAsync("git", ["diff", "--quiet", "HEAD", "--"], {
      cwd: repositoryRoot,
    });
  } catch {
    throw new Error("Tracked release files differ from EXPECTED_RELEASE_COMMIT");
  }

  let untracked;
  try {
    const result = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot },
    );
    untracked = result.stdout;
  } catch {
    throw new Error("Unable to inspect untracked release files");
  }
  if (untracked.length > 0) {
    throw new Error(
      "Untracked release files are present; use a clean checkout and keep release evidence outside it",
    );
  }

  let ignoredEnvironmentFiles;
  try {
    const result = await execFileAsync(
      "git",
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ".env",
        ".env.*",
      ],
      { cwd: repositoryRoot },
    );
    ignoredEnvironmentFiles = result.stdout;
  } catch {
    throw new Error("Unable to inspect ignored release environment files");
  }
  if (ignoredEnvironmentFiles.length > 0) {
    throw new Error(
      "Ignored root environment files are present; use a pristine release checkout and supply release configuration externally",
    );
  }
}
