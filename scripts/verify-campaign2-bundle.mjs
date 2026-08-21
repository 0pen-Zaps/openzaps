#!/usr/bin/env node
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committed = join(root, "executor", "dist", "campaign2-keeper");
const temporaryRoot = mkdtempSync(join(tmpdir(), "openzaps-campaign2-bundle-"));
const rebuilt = join(temporaryRoot, "campaign2-keeper");
const expectedFiles = ["254.index.mjs", "index.mjs", "licenses.txt"];

try {
  const ncc = join(root, "node_modules", "@vercel", "ncc", "dist", "ncc", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      ncc,
      "build",
      "executor/campaign2-cli.mjs",
      "-o",
      rebuilt,
      "-m",
      "--no-cache",
      "--license",
      "licenses.txt",
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Campaign 2 ncc rebuild failed with exit ${result.status ?? "unknown"}`);
  }
  const actualFiles = readdirSync(rebuilt).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Campaign 2 bundle file set changed: ${actualFiles.join(", ")}`);
  }
  for (const name of expectedFiles) {
    const expected = readFileSync(join(committed, name));
    const actual = readFileSync(join(rebuilt, name));
    if (!expected.equals(actual)) {
      throw new Error(
        `Campaign 2 committed ${name} is stale; run npm run campaign2:bundle and review the diff`,
      );
    }
  }
  process.stdout.write("Campaign 2 source and committed ncc bundle match byte-for-byte.\n");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
