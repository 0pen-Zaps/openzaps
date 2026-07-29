import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkFinalizedBlockQuorum,
  checkLateBlockQuorum,
  parseLateBlockRpcUrls,
} from "./late-block.mjs";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;

function rpc({
  chainId = 4663,
  number = 100n,
  timestamp = 990n,
  hash = HASH_A,
  anchorHashes = {},
  simulationError = null,
  simulationResult = undefined,
} = {}) {
  return {
    getChainId: async () => chainId,
    getBlock: async ({ blockNumber } = {}) => {
      if (typeof blockNumber === "bigint") {
        return {
          number: blockNumber,
          timestamp,
          hash: anchorHashes[blockNumber.toString()] ?? hash,
        };
      }
      return { number, timestamp, hash };
    },
    simulateContract: async () => {
      if (simulationError) throw simulationError;
      return simulationResult;
    },
  };
}

test("late-block RPC parsing enforces HTTPS and distinct origins without exposing values", () => {
  const endpoints = parseLateBlockRpcUrls(
    JSON.stringify(["https://rpc-a.example/key", "https://rpc-b.example/key"]),
  );
  assert.deepEqual(
    endpoints.map(({ origin }) => origin),
    ["https://rpc-a.example", "https://rpc-b.example"],
  );
  assert.throws(
    () => parseLateBlockRpcUrls(JSON.stringify(["https://rpc-a.example/a", "https://rpc-a.example/b"])),
    /distinct origins/,
  );
  assert.throws(
    () => parseLateBlockRpcUrls(JSON.stringify(["http://rpc-a.example/key"])),
    /must use HTTPS/,
  );
  assert.equal(parseLateBlockRpcUrls("").length, 0);
});

test("two independent nodes agree one recent block and re-simulate on that exact height", async () => {
  const simulatedAt = [];
  const clients = [
    { client: rpc({ number: 101n, anchorHashes: { 100: HASH_A } }) },
    { client: rpc({ number: 100n, hash: HASH_A }) },
  ];
  const result = await checkLateBlockQuorum({
    clients,
    chainId: 4663,
    minimumAgreement: 2,
    maxHeadSkewBlocks: 2,
    maxBlockAgeSeconds: 60,
    nowSeconds: 1_000,
    simulate: async (client, blockNumber) => {
      simulatedAt.push(blockNumber);
      return client.simulateContract({ blockNumber });
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockNumber, 100n);
  assert.equal(result.blockHash, HASH_A);
  assert.deepEqual(simulatedAt, [100n, 100n]);
});

test("admission fails closed when the quorum is absent, stale, or disagrees", async (t) => {
  await t.test("not configured", async () => {
    const result = await checkLateBlockQuorum({
      clients: [{ client: rpc() }],
      chainId: 4663,
      minimumAgreement: 2,
      nowSeconds: 1_000,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.outcome, "late-block-quorum-unavailable");
  });

  await t.test("sequencer heads are stale", async () => {
    const result = await checkLateBlockQuorum({
      clients: [
        { client: rpc({ timestamp: 900n }) },
        { client: rpc({ timestamp: 900n }) },
      ],
      chainId: 4663,
      minimumAgreement: 2,
      maxBlockAgeSeconds: 60,
      nowSeconds: 1_000,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.outcome, "sequencer-stale");
  });

  await t.test("canonical hashes disagree", async () => {
    const result = await checkLateBlockQuorum({
      clients: [
        { client: rpc({ hash: HASH_A }) },
        { client: rpc({ hash: HASH_B }) },
      ],
      chainId: 4663,
      minimumAgreement: 2,
      nowSeconds: 1_000,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.outcome, "late-block-quorum-disagrees");
  });
});

test("a split simulation result never reaches signer admission", async () => {
  const result = await checkLateBlockQuorum({
    clients: [
      { client: rpc() },
      { client: rpc({ simulationError: new Error("execution reverted") }) },
    ],
    chainId: 4663,
    minimumAgreement: 2,
    nowSeconds: 1_000,
    simulate: (client, blockNumber) => client.simulateContract({ blockNumber }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "late-block-simulation-failed");
});

test("successful but different simulation return data does not form a quorum", async () => {
  const result = await checkLateBlockQuorum({
    clients: [
      { client: rpc({ simulationResult: "0x01" }) },
      { client: rpc({ simulationResult: "0x02" }) },
    ],
    chainId: 4663,
    minimumAgreement: 2,
    nowSeconds: 1_000,
    simulate: (client, blockNumber) => client.simulateContract({ blockNumber }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "late-block-simulation-failed");
});

test("an anchor reorg between agreement and simulation fails admission", async () => {
  const drifting = rpc();
  const getDriftingBlock = drifting.getBlock;
  drifting.getBlock = async ({ blockNumber } = {}) => {
    const block = await getDriftingBlock({ blockNumber });
    return typeof blockNumber === "bigint" ? { ...block, hash: HASH_B } : block;
  };
  const result = await checkLateBlockQuorum({
    clients: [
      { client: drifting },
      { client: rpc() },
    ],
    chainId: 4663,
    minimumAgreement: 2,
    nowSeconds: 1_000,
    simulate: (client, blockNumber) => client.simulateContract({ blockNumber }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "late-block-simulation-failed");
});

test("receipt settlement requires independent nodes to agree on one recent finalized anchor", async () => {
  const ready = await checkFinalizedBlockQuorum({
    clients: [
      { client: rpc({ number: 90n, timestamp: 980n, hash: HASH_A }) },
      { client: rpc({ number: 90n, timestamp: 980n, hash: HASH_A }) },
    ],
    chainId: 4663,
    minimumAgreement: 2,
    maxBlockAgeSeconds: 60,
    nowSeconds: 1_000,
  });
  assert.equal(ready.allowed, true);
  assert.equal(ready.block.number, 90n);
  assert.equal(ready.agreeingOrigins, 2);

  const disagree = await checkFinalizedBlockQuorum({
    clients: [
      { client: rpc({ number: 90n, timestamp: 980n, hash: HASH_A }) },
      { client: rpc({ number: 90n, timestamp: 980n, hash: HASH_B }) },
    ],
    chainId: 4663,
    minimumAgreement: 2,
    maxBlockAgeSeconds: 60,
    nowSeconds: 1_000,
  });
  assert.equal(disagree.allowed, false);
  assert.equal(disagree.outcome, "finality-quorum-disagrees");
});
