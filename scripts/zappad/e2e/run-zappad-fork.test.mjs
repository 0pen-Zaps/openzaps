import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildZapPadNextEnvironment } from "./run-zappad-fork.mjs";

const PACKAGE_JSON = new URL("../../../package.json", import.meta.url);

describe("ZapPad browser-fork wiring", () => {
  it("uses only the canonical scoped launcher environment names", () => {
    const environment = buildZapPadNextEnvironment({
      baseUrl: "http://localhost:3100",
      deployBlock: 123,
      launcher: "0x1000000000000000000000000000000000000001",
      launcherCodeHash: `0x${"11".repeat(32)}`,
      nextDistRelative: "output/playwright/zappad/next-dev-test",
      rpcUrl: "http://127.0.0.1:8545",
    });

    expect(environment).toMatchObject({
      ZAPPAD_LAUNCHER_ADDRESS:
        "0x1000000000000000000000000000000000000001",
      ZAPPAD_LAUNCHER_DEPLOY_BLOCK: "123",
      ZAPPAD_LAUNCHER_CODE_HASH: `0x${"11".repeat(32)}`,
      ZAPPAD_LAUNCH_WRITES_ENABLED: "true",
      ZAPPAD_RPC_DURABLE_QUOTA_ENABLED: "true",
      ZAPPAD_RPC_RELAY_ENABLED: "true",
      ZAPPAD_RPC_URL: "http://127.0.0.1:8545",
    });
    expect(Object.keys(environment).filter((name) => name.includes("LAUNCH"))).toEqual([
      "ZAPPAD_LAUNCHER_ADDRESS",
      "ZAPPAD_LAUNCHER_DEPLOY_BLOCK",
      "ZAPPAD_LAUNCHER_CODE_HASH",
      "ZAPPAD_LAUNCH_WRITES_ENABLED",
    ]);
  });

  it("keeps the package entrypoint on the namespaced runner", async () => {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));

    expect(packageJson.scripts["test:zappad:e2e:fork"]).toBe(
      "node scripts/zappad/e2e/run-zappad-fork.mjs",
    );
  });
});
