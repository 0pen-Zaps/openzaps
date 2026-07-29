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
const POLICY_HASH = `0x${"34".repeat(32)}`;
const IMPLEMENTATION_RUNTIME = "0x6001600055";
const IMPLEMENTATION_HASH = keccak256(IMPLEMENTATION_RUNTIME);
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
  capsuleLineages: {
    v3: { factory: FACTORY, implementation: IMPLEMENTATION },
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
  ], () => {
    reads += 1;
  });

  const first = await verifyExecutionTargetProvenance(client, ITEM, CFG);
  const afterFirst = reads;
  const second = await verifyExecutionTargetProvenance(client, ITEM, CFG);
  assert.equal(first.verified, true);
  assert.equal(second.creationBlock, 90n);
  assert.equal(reads, afterFirst);
});

function provenanceClient(creationLogs, onRead = () => {}) {
  return {
    getBlockNumber: async () => {
      onRead();
      return 100n;
    },
    readContract: async ({ address, functionName }) => {
      onRead();
      if (address.toLowerCase() === FACTORY.toLowerCase()) {
        if (functionName === "implementation") return IMPLEMENTATION;
        if (functionName === "implCodeHash") return IMPLEMENTATION_HASH;
      }
      if (address.toLowerCase() === ZAP.toLowerCase()) {
        if (functionName === "FACTORY") return FACTORY;
        if (functionName === "owner") return OWNER;
        if (functionName === "policyHash") return POLICY_HASH;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBytecode: async ({ address }) => {
      onRead();
      if (address.toLowerCase() === FACTORY.toLowerCase()) return "0x60006000";
      if (address.toLowerCase() === IMPLEMENTATION.toLowerCase()) return IMPLEMENTATION_RUNTIME;
      if (address.toLowerCase() === ZAP.toLowerCase()) return CLONE_RUNTIME;
      return undefined;
    },
    getLogs: async () => {
      onRead();
      return creationLogs;
    },
  };
}
