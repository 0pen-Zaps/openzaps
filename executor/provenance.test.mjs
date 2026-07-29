import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";

import {
  CapsuleProvenanceError,
  clearCapsuleProvenanceCache,
  verifyExecutionTargetProvenance,
} from "./provenance.mjs";

const FACTORY = "0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9";
const IMPLEMENTATION = "0x0309E72Ffd1c6855FF519d9E923AEFc0C52bFdb5";
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033";
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADAPTER_REGISTRY = "0x9E56e444f490C00A6277326A47Cb462E12dF1f17";
const ADAPTER = "0x04f62dA4b51a010eFa32aa81569169C47AEd602C";
const ZAPS_ADAPTER = "0x1111111111111111111111111111111111111111";
const POLICY_HASH = `0x${"34".repeat(32)}`;
const IMPLEMENTATION_RUNTIME = "0x6001600055";
const IMPLEMENTATION_HASH = keccak256(IMPLEMENTATION_RUNTIME);
const ADAPTER_RUNTIME = "0x6002600055";
const ADAPTER_HASH = keccak256(ADAPTER_RUNTIME);
const ZAPS_ADAPTER_RUNTIME = "0x6003600055";
const ZAPS_ADAPTER_HASH = keccak256(ZAPS_ADAPTER_RUNTIME);
const CLONE_RUNTIME =
  `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

const ITEM = {
  kind: "recurring",
  intent: {
    zap: ZAP,
    policyHash: POLICY_HASH,
  },
};

const CFG = {
  chainId: 4663,
  watchOnly: false,
  capsuleLineages: {
    v3: { factory: FACTORY, implementation: IMPLEMENTATION },
    "v3.2": { factory: FACTORY, implementation: IMPLEMENTATION },
  },
  adapterManifest: {
    version: 1,
    chainId: 4663,
    adapters: {
      [ADAPTER.toLowerCase()]: {
        address: ADAPTER,
        runtimeCodeHash: ADAPTER_HASH,
      },
      [ZAPS_ADAPTER.toLowerCase()]: {
        address: ZAPS_ADAPTER,
        runtimeCodeHash: ZAPS_ADAPTER_HASH,
      },
    },
  },
};

test("executor rejects an exact-runtime lookalike with no canonical factory creation log", async () => {
  clearCapsuleProvenanceCache();
  const client = provenanceClient([]);

  await assert.rejects(
    verifyExecutionTargetProvenance(client, ITEM, CFG),
    (error) =>
      error instanceof CapsuleProvenanceError
      && /no matching ZapCreated provenance/.test(error.message),
  );
});

test("executor accepts and caches a fully factory-proven canonical clone", async () => {
  clearCapsuleProvenanceCache();
  let reads = 0;
  let creationLogReads = 0;
  let adapterRuntimeReads = 0;
  const client = provenanceClient([
    {
      args: {
        zap: ZAP,
        owner: OWNER,
        policyHash: POLICY_HASH,
        implCodeHash: IMPLEMENTATION_HASH,
      },
      transactionHash: `0x${"78".repeat(32)}`,
      blockNumber: 90n,
    },
  ], (operation) => {
    reads += 1;
    if (operation === "creation-logs") creationLogReads += 1;
    if (operation === "adapter-runtime") adapterRuntimeReads += 1;
  });

  const first = await verifyExecutionTargetProvenance(client, ITEM, CFG);
  const afterFirst = reads;
  const second = await verifyExecutionTargetProvenance(client, ITEM, CFG);
  assert.equal(first.verified, true);
  assert.equal(first.adapterManifest.verified, true);
  assert.equal(second.creationBlock, 90n);
  assert.equal(second.adapterManifest.verified, true);
  assert.ok(reads > afterFirst, "live adapter dependencies must be rechecked");
  assert.equal(creationLogReads, 1, "immutable canonical creation proof stays cached");
  assert.equal(adapterRuntimeReads, 2, "adapter runtime is checked before every submission");
});

test("a signing executor fails closed when a route adapter is absent from the manifest", async () => {
  clearCapsuleProvenanceCache();
  const client = provenanceClient(canonicalCreationLogs());

  await assert.rejects(
    verifyExecutionTargetProvenance(client, ITEM, {
      ...CFG,
      watchOnly: undefined,
      adapterManifest: null,
      adapterManifestError: "adapter manifest not found",
    }),
    (error) =>
      error instanceof CapsuleProvenanceError
      && /adapter manifest verification failed: adapter manifest not found/.test(error.message),
  );
});

test("watch-only reports an uncovered route without treating its observed hash as approval", async () => {
  clearCapsuleProvenanceCache();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const proof = await verifyExecutionTargetProvenance(
      provenanceClient(canonicalCreationLogs()),
      ITEM,
      {
        ...CFG,
        watchOnly: true,
        adapterManifest: null,
        adapterManifestError: "adapter manifest not found",
      },
    );
    assert.equal(proof.adapterManifest.verified, false);
    assert.equal(proof.adapterManifest.status, "manifest-gap");
    assert.deepEqual(proof.adapterManifest.missing, [ADAPTER]);
    assert.equal(proof.adapterManifest.adapters[0].manifestRuntimeCodeHash, null);
    assert.match(warnings[0], /watch-only adapter manifest gap/);
  } finally {
    console.warn = originalWarn;
  }
});

test("a known adapter runtime mismatch blocks even watch-only before simulation", async () => {
  clearCapsuleProvenanceCache();
  await assert.rejects(
    verifyExecutionTargetProvenance(
      provenanceClient(canonicalCreationLogs()),
      ITEM,
      {
        ...CFG,
        watchOnly: true,
        adapterManifest: {
          ...CFG.adapterManifest,
          adapters: {
            [ADAPTER.toLowerCase()]: {
              address: ADAPTER,
              runtimeCodeHash: `0x${"ff".repeat(32)}`,
            },
          },
        },
      },
    ),
    (error) =>
      error instanceof CapsuleProvenanceError
      && /runtime hash .* does not match manifest/.test(error.message),
  );
});

test("recurring-stack verifies its immutable ZAPS_ADAPTER as well as policy steps", async () => {
  clearCapsuleProvenanceCache();
  const proof = await verifyExecutionTargetProvenance(
    provenanceClient(canonicalCreationLogs(), () => {}, { zapsAdapter: ZAPS_ADAPTER }),
    {
      ...ITEM,
      kind: "recurring-stack",
    },
    CFG,
  );
  assert.deepEqual(
    proof.adapterManifest.adapters.map(({ address }) => address),
    [ADAPTER, ZAPS_ADAPTER],
  );
  assert.equal(proof.adapterManifest.verified, true);
});

test("registry retirement blocks an otherwise matching release-manifest adapter", async () => {
  clearCapsuleProvenanceCache();
  await assert.rejects(
    verifyExecutionTargetProvenance(
      provenanceClient(canonicalCreationLogs(), () => {}, { allowed: false }),
      ITEM,
      CFG,
    ),
    (error) =>
      error instanceof CapsuleProvenanceError
      && /is not currently allowed by registry/.test(error.message),
  );
});

function canonicalCreationLogs() {
  return [
    {
      args: {
        zap: ZAP,
        owner: OWNER,
        policyHash: POLICY_HASH,
        implCodeHash: IMPLEMENTATION_HASH,
      },
      transactionHash: `0x${"78".repeat(32)}`,
      blockNumber: 90n,
    },
  ];
}

function provenanceClient(
  creationLogs,
  onRead = () => {},
  { allowed = true, zapsAdapter = ZAPS_ADAPTER } = {},
) {
  return {
    getBlockNumber: async () => {
      onRead("head");
      return 100n;
    },
    readContract: async ({ address, functionName }) => {
      onRead(`contract:${functionName}`);
      if (address.toLowerCase() === FACTORY.toLowerCase()) {
        if (functionName === "implementation") return IMPLEMENTATION;
        if (functionName === "implCodeHash") return IMPLEMENTATION_HASH;
      }
      if (address.toLowerCase() === ZAP.toLowerCase()) {
        if (functionName === "FACTORY") return FACTORY;
        if (functionName === "owner") return OWNER;
        if (functionName === "policyHash") return POLICY_HASH;
        if (functionName === "stepCount") return 1n;
        if (functionName === "ADAPTERS") return ADAPTER_REGISTRY;
        if (functionName === "ZAPS_ADAPTER") return zapsAdapter;
        if (functionName === "step") {
          return {
            adapter: ADAPTER,
            tokenIn: "0x2222222222222222222222222222222222222222",
            spender: ADAPTER,
            amountIn: 1n,
            data: "0x",
          };
        }
      }
      if (
        address.toLowerCase() === ADAPTER_REGISTRY.toLowerCase()
        && functionName === "isAllowed"
      ) {
        return allowed;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBytecode: async ({ address }) => {
      onRead(
        address.toLowerCase() === ADAPTER.toLowerCase()
          ? "adapter-runtime"
          : address.toLowerCase() === ZAPS_ADAPTER.toLowerCase()
            ? "zaps-adapter-runtime"
            : "canonical-runtime",
      );
      if (address.toLowerCase() === FACTORY.toLowerCase()) return "0x60006000";
      if (address.toLowerCase() === IMPLEMENTATION.toLowerCase()) return IMPLEMENTATION_RUNTIME;
      if (address.toLowerCase() === ZAP.toLowerCase()) return CLONE_RUNTIME;
      if (address.toLowerCase() === ADAPTER.toLowerCase()) return ADAPTER_RUNTIME;
      if (address.toLowerCase() === ZAPS_ADAPTER.toLowerCase()) return ZAPS_ADAPTER_RUNTIME;
      return undefined;
    },
    getLogs: async () => {
      onRead("creation-logs");
      return creationLogs;
    },
  };
}
