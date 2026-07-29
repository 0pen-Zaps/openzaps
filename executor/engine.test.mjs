import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkPendingBaseFee,
  checkNonceLane,
  classifySubmissionError,
  evaluateTrigger,
  mapWithConcurrency,
  submitExecution,
} from "./engine.mjs";

const ITEM = {
  kind: "recurring",
  signature: `0x${"ab".repeat(65)}`,
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: 3_000_000n,
    maxFeePerGas: 10_000_000_000n,
  },
};

const CFG = {
  maxFeePerGasWei: 2_000_000_000n,
  confirmations: 7,
  receiptTimeoutMs: 45_000,
};
const allowCanonicalTarget = async () => ({ verified: true });

test("submission persists the hash before waiting and leaves finality to canonical settlement", async () => {
  const order = [];
  let waitArgs;
  const publicClient = {
    simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
    getBlock: async () => ({ baseFeePerGas: 1n }),
    waitForTransactionReceipt: async (args) => {
      order.push("wait");
      waitArgs = args;
      return { status: "success", blockNumber: 123n };
    },
  };
  const walletClient = {
    account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
    writeContract: async () => {
      order.push("broadcast");
      return `0x${"12".repeat(32)}`;
    },
  };
  const result = await submitExecution(publicClient, walletClient, ITEM, CFG, async () => {
    order.push("outbox");
  }, allowCanonicalTarget);
  assert.deepEqual(order, ["broadcast", "outbox", "wait"]);
  assert.equal(waitArgs.confirmations, 7);
  assert.equal(waitArgs.timeout, 45_000);
  assert.equal(result.outcome, "confirmation-observed");
  assert.equal(result.observedReceiptStatus, "success");
});

test("a post-broadcast finality timeout retains the hash as confirmation-pending", async () => {
  const hash = `0x${"34".repeat(32)}`;
  const result = await submitExecution(
    {
      simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => {
        throw new Error("timeout");
      },
    },
    { account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }, writeContract: async () => hash },
    ITEM,
    CFG,
    async () => {},
    allowCanonicalTarget,
  );
  assert.equal(result.outcome, "confirmation-pending");
  assert.equal(result.txHash, hash);
});

test("submission surfaces private relay health and inclusion outcome", async () => {
  const hash = `0x${"35".repeat(32)}`;
  const relayOutcome = {
    hash,
    mode: "private-multi-relay",
    status: "accepted-degraded",
    requiredDistinctOrigins: 2,
    attemptedOrigins: 2,
    acceptedOrigins: 1,
    unknownOrigins: 1,
    rejectedOrigins: 0,
    endpoints: [
      { id: "relay-a", origin: "https://relay-a.example", status: "accepted" },
      { id: "relay-b", origin: "https://relay-b.example", status: "unknown" },
    ],
  };
  const result = await submitExecution(
    {
      simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 125n }),
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => hash,
      openZapsPrivateSubmission: {
        getOutcome: () => relayOutcome,
      },
    },
    ITEM,
    CFG,
    async () => {},
    allowCanonicalTarget,
  );
  assert.equal(result.outcome, "confirmation-observed");
  assert.equal(result.privateSubmission.status, "accepted-degraded");
  assert.equal(result.privateSubmission.inclusion, "receipt-observed");
  assert.match(result.detail, /private relays accepted-degraded/);
});

test("private submission journals signed bytes before dispatch and binds preparation fields", async () => {
  const hash = `0x${"36".repeat(32)}`;
  const raw = "0x0201";
  const events = [];
  let preparationHook;
  const privateSubmission = {
    withPreparationHook: async (hook, operation) => {
      preparationHook = hook;
      try {
        return await operation();
      } finally {
        preparationHook = null;
      }
    },
    getOutcome: () => ({
      hash,
      mode: "private-multi-relay",
      status: "accepted-quorum",
      requiredDistinctOrigins: 2,
      attemptedOrigins: 2,
      acceptedOrigins: 2,
      unknownOrigins: 0,
      rejectedOrigins: 0,
      endpoints: [],
    }),
  };
  let writeRequest;
  const result = await submitExecution(
    {
      simulateContract: async () => ({
        request: {
          address: ITEM.intent.zap,
          gas: ITEM.intent.maxGas,
        },
      }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => {
        events.push("wait");
        return { status: "success", blockNumber: 126n };
      },
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      openZapsPrivateSubmission: privateSubmission,
      writeContract: async (request) => {
        writeRequest = request;
        await preparationHook({ hash, serializedTransaction: raw });
        events.push("dispatch");
        return hash;
      },
    },
    ITEM,
    { ...CFG, chainId: 4663 },
    async ({ phase, serializedTransaction }) => {
      events.push(phase);
      if (phase === "prepared") assert.equal(serializedTransaction, raw);
    },
    allowCanonicalTarget,
    async () => ({ allowed: true, latestNonce: 7n }),
  );
  assert.deepEqual(events, ["prepared", "dispatch", "submitted", "wait"]);
  assert.equal(writeRequest.chainId, 4663);
  assert.equal(writeRequest.nonce, 7);
  assert.equal(writeRequest.type, "eip1559");
  assert.equal(result.privateSubmission.inclusion, "receipt-observed");
});

test("an outbox persistence error never mislabels an already-broadcast transaction", async () => {
  const hash = `0x${"45".repeat(32)}`;
  const result = await submitExecution(
    {
      simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 124n }),
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => hash,
    },
    ITEM,
    CFG,
    async () => {
      throw new Error("state disk full");
    },
    allowCanonicalTarget,
  );

  assert.equal(result.outcome, "confirmation-observed");
  assert.equal(result.observedReceiptStatus, "success");
  assert.equal(result.txHash, hash);
  assert.match(result.detail, /outbox persistence failed: state disk full/);
});

test("a provenance failure refuses the target before simulation or broadcast", async () => {
  let simulated = false;
  let broadcast = false;
  const result = await submitExecution(
    {
      simulateContract: async () => {
        simulated = true;
        return { request: { address: ITEM.intent.zap } };
      },
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => {
        broadcast = true;
        return `0x${"56".repeat(32)}`;
      },
    },
    ITEM,
    CFG,
    async () => {},
    async () => {
      throw new Error("canonical factory has no matching ZapCreated provenance");
    },
  );

  assert.equal(result.outcome, "blocked");
  assert.match(result.detail, /capsule provenance failed/i);
  assert.equal(simulated, false);
  assert.equal(broadcast, false);
});

test("the pre-send gate defers without writing and preserves its explicit reason", async () => {
  let broadcasts = 0;
  const result = await submitExecution(
    {
      simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => {
        broadcasts += 1;
        return `0x${"78".repeat(32)}`;
      },
    },
    ITEM,
    CFG,
    async () => {},
    allowCanonicalTarget,
    async () => ({
      allowed: false,
      outcome: "receipt-persistence-halted",
      detail: "receipt state storage must be repaired",
    }),
  );

  assert.equal(result.outcome, "receipt-persistence-halted");
  assert.match(result.detail, /must be repaired/);
  assert.equal(broadcasts, 0);
});

test("execution does not write when the pending base fee cannot be proven under the cap", async () => {
  let broadcasts = 0;
  const result = await submitExecution(
    {
      simulateContract: async () => ({ request: { address: ITEM.intent.zap } }),
      getBlock: async () => {
        throw new Error("pending fee RPC unavailable");
      },
    },
    {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => {
        broadcasts += 1;
        return `0x${"89".repeat(32)}`;
      },
    },
    ITEM,
    CFG,
    async () => {},
    allowCanonicalTarget,
  );

  assert.equal(result.outcome, "fee-market-unknown");
  assert.match(result.detail, /pending fee RPC unavailable/);
  assert.equal(broadcasts, 0);
});

test("nonce-lane admission fails closed for pending, inconsistent, and unreadable RPC views", async () => {
  const walletClient = { account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" } };

  const clear = await checkNonceLane(
    {
      getTransactionCount: async ({ blockTag }) => (blockTag === "latest" ? 7 : 7),
    },
    walletClient,
  );
  assert.equal(clear.allowed, true);

  const pending = await checkNonceLane(
    {
      getTransactionCount: async ({ blockTag }) => (blockTag === "latest" ? 7 : 8),
    },
    walletClient,
  );
  assert.equal(pending.allowed, false);
  assert.equal(pending.outcome, "nonce-lane-pending");

  const inconsistent = await checkNonceLane(
    {
      getTransactionCount: async ({ blockTag }) => (blockTag === "latest" ? 8 : 7),
    },
    walletClient,
  );
  assert.equal(inconsistent.allowed, false);
  assert.equal(inconsistent.outcome, "nonce-lane-unknown");

  const unavailable = await checkNonceLane(
    {
      getTransactionCount: async () => {
        throw new Error("RPC unavailable");
      },
    },
    walletClient,
  );
  assert.equal(unavailable.allowed, false);
  assert.equal(unavailable.outcome, "nonce-lane-unknown");
  assert.match(unavailable.detail, /RPC unavailable/);
});

test("pending base-fee admission fails closed on unreadable, absent, or above-cap values", async () => {
  const unavailable = await checkPendingBaseFee(
    {
      getBlock: async () => {
        throw new Error("pending block unavailable");
      },
    },
    10n,
  );
  assert.equal(unavailable.allowed, false);
  assert.equal(unavailable.outcome, "fee-market-unknown");

  const absent = await checkPendingBaseFee(
    { getBlock: async () => ({ baseFeePerGas: null }) },
    10n,
  );
  assert.equal(absent.allowed, false);
  assert.equal(absent.outcome, "fee-market-unknown");

  const aboveCap = await checkPendingBaseFee(
    { getBlock: async () => ({ baseFeePerGas: 11n }) },
    10n,
  );
  assert.equal(aboveCap.allowed, false);
  assert.equal(aboveCap.outcome, "gas-above-cap");

  const allowed = await checkPendingBaseFee(
    { getBlock: async () => ({ baseFeePerGas: 10n }) },
    10n,
  );
  assert.equal(allowed.allowed, true);
});

test("trigger evaluation blocks malformed signed bounds before time or price-source reads", async (t) => {
  const baseIntent = {
    zap: ITEM.intent.zap,
    nonce: 1n,
    validAfter: 10_000n,
    deadline: 20_000n,
    priceSource: "0x1111111111111111111111111111111111111111",
    baselinePriceX96: 100n,
    thresholdBps: 1n,
    above: true,
  };
  const malformed = [
    ["zero baseline", { baselinePriceX96: 0n }, /baselinePriceX96/],
    ["zero threshold", { thresholdBps: 0n }, /greater than zero/],
    ["below at 10000 bps", { above: false, thresholdBps: 10_000n }, /less than 10000/],
    ["above over 1000000 bps", { above: true, thresholdBps: 1_000_001n }, /exceeds 1000000/],
  ];

  for (const [name, overrides, detail] of malformed) {
    await t.test(name, async () => {
      let reads = 0;
      const result = await evaluateTrigger(
        {
          readContract: async () => {
            reads += 1;
            return 1n;
          },
        },
        { kind: "trigger", intent: { ...baseIntent, ...overrides } },
        1n,
      );
      assert.equal(result.status, "blocked");
      assert.match(result.detail, detail);
      assert.equal(reads, 0);
    });
  }
});

test("trigger evaluation accepts the capsule's threshold boundaries", async () => {
  const baseIntent = {
    zap: ITEM.intent.zap,
    nonce: 1n,
    validAfter: 0n,
    deadline: 20_000n,
    priceSource: "0x1111111111111111111111111111111111111111",
    baselinePriceX96: 100n,
  };
  for (const threshold of [
    { above: false, thresholdBps: 9_999n },
    { above: true, thresholdBps: 1_000_000n },
  ]) {
    const functions = [];
    const result = await evaluateTrigger(
      {
        readContract: async ({ functionName }) => {
          functions.push(functionName);
          return functionName === "nonceUsed" ? false : 100n;
        },
      },
      { kind: "trigger", intent: { ...baseIntent, ...threshold } },
      1n,
    );
    assert.ok(["due", "waiting"].includes(result.status));
    assert.deepEqual(functions, ["nonceUsed", "priceX96"]);
  }
});

test("underfunding is distinct from other fail-closed simulation blockers", () => {
  assert.equal(classifySubmissionError({ errorName: "ZeroBalanceRelativeStep" }), "underfunded");
  assert.equal(classifySubmissionError({ shortMessage: "ERC20InsufficientBalance" }), "underfunded");
  assert.equal(classifySubmissionError({ errorName: "MinOutNotMet" }), "blocked");
});

test("evaluation worker pool is concurrency-bounded and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.equal(peak, 2);
});
