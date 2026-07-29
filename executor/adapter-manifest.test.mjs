import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";

import {
  AdapterManifestConfigError,
  AdapterManifestVerificationError,
  loadAdapterManifestFile,
  parseAdapterManifest,
  verifyPotAdapterManifest,
} from "./adapter-manifest.mjs";

const ADAPTER = "0x04f62dA4b51a010eFa32aa81569169C47AEd602C";
const RUNTIME_HASH = `0x${"12".repeat(32)}`;
const POT = "0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1";
const REGISTRY = "0x9E56e444f490C00A6277326A47Cb462E12dF1f17";
const ZAPS = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07";
const POT_ADAPTER_RUNTIME = "0x6001600055";
const POT_ADAPTER_HASH = keccak256(POT_ADAPTER_RUNTIME);

test("adapter manifest parser normalizes a chain-bound release entry", () => {
  const parsed = parseAdapterManifest(
    {
      version: 1,
      chainId: "4663",
      adapters: [
        {
          label: "synthetic test adapter",
          address: ADAPTER.toLowerCase(),
          runtimeCodeHash: RUNTIME_HASH.toUpperCase().replace("0X", "0x"),
        },
      ],
    },
    4663,
  );

  assert.equal(parsed.version, 1);
  assert.equal(parsed.chainId, 4663);
  assert.deepEqual(parsed.adapters[ADAPTER.toLowerCase()], {
    address: ADAPTER,
    runtimeCodeHash: RUNTIME_HASH,
    label: "synthetic test adapter",
  });
});

test("adapter manifest parser rejects wrong-chain and duplicate release entries", () => {
  assert.throws(
    () =>
      parseAdapterManifest(
        { version: 1, chainId: 8453, adapters: [] },
        4663,
      ),
    (error) =>
      error instanceof AdapterManifestConfigError
      && /does not match executor chain/.test(error.message),
  );

  assert.throws(
    () =>
      parseAdapterManifest(
        {
          version: 1,
          chainId: 4663,
          adapters: [
            { address: ADAPTER, runtimeCodeHash: RUNTIME_HASH },
            { address: ADAPTER.toLowerCase(), runtimeCodeHash: RUNTIME_HASH },
          ],
        },
        4663,
      ),
    (error) =>
      error instanceof AdapterManifestConfigError
      && /duplicate address/.test(error.message),
  );
});

test("adapter manifest loader reports absent and malformed files without inventing pins", () => {
  const directory = mkdtempSync(join(tmpdir(), "openzaps-adapter-manifest-"));
  try {
    const missing = loadAdapterManifestFile(join(directory, "missing.json"), 4663);
    assert.equal(missing.manifest, null);
    assert.match(missing.error, /not found/);

    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, JSON.stringify({
      version: 1,
      chainId: "4663",
      adapters: [{ address: ADAPTER, runtimeCodeHash: "observed-later" }],
    }));
    const malformed = loadAdapterManifestFile(malformedPath, 4663);
    assert.equal(malformed.manifest, null);
    assert.match(malformed.error, /malformed runtimeCodeHash/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function potClient({ runtime = POT_ADAPTER_RUNTIME, allowed = true } = {}) {
  return {
    readContract: async ({ functionName }) => {
      if (functionName === "BUY_ADAPTER") return ADAPTER;
      if (functionName === "ZAPS") return ZAPS;
      if (functionName === "isAllowed") return allowed;
      throw new Error(`unexpected function ${functionName}`);
    },
    getBytecode: async () => runtime,
  };
}

function potConfig(runtimeCodeHash) {
  return {
    lotteryPot: POT,
    adapterRegistry: REGISTRY,
    zapsToken: ZAPS,
    adapterManifest: runtimeCodeHash
      ? {
          adapters: {
            [ADAPTER.toLowerCase()]: {
              address: ADAPTER,
              runtimeCodeHash,
              label: "pot conversion adapter",
            },
          },
        }
      : null,
    adapterManifestError: runtimeCodeHash ? null : "reviewed manifest is unavailable",
  };
}

test("pot conversion reports a missing release-manifest pin without approving the observed hash", async () => {
  const result = await verifyPotAdapterManifest(
    potClient(),
    potConfig(null),
    123n,
  );
  assert.equal(result.verified, false);
  assert.equal(result.status, "manifest-gap");
  assert.equal(result.runtimeCodeHash, POT_ADAPTER_HASH);
  assert.equal(result.manifestRuntimeCodeHash, null);
});

test("pot conversion rejects a known runtime mismatch and a retired adapter", async (t) => {
  await t.test("runtime mismatch", async () => {
    await assert.rejects(
      verifyPotAdapterManifest(
        potClient(),
        potConfig(`0x${"34".repeat(32)}`),
        123n,
      ),
      (error) =>
        error instanceof AdapterManifestVerificationError
        && /does not match manifest/.test(error.message),
    );
  });

  await t.test("registry retirement", async () => {
    await assert.rejects(
      verifyPotAdapterManifest(
        potClient({ allowed: false }),
        potConfig(POT_ADAPTER_HASH),
        123n,
      ),
      (error) =>
        error instanceof AdapterManifestVerificationError
        && /not currently allowed/.test(error.message),
    );
  });
});

test("pot conversion verifies its pinned token, registry state, and release runtime", async () => {
  const result = await verifyPotAdapterManifest(
    potClient(),
    potConfig(POT_ADAPTER_HASH),
    123n,
  );
  assert.equal(result.verified, true);
  assert.equal(result.adapter, ADAPTER);
  assert.equal(result.zaps, ZAPS);
  assert.equal(result.runtimeCodeHash, POT_ADAPTER_HASH);
});
