import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";

import {
  HOSTED_DELIVERY_MAX_ATTEMPTS,
  RECEIPT_OUTBOX_LIMIT,
  accountSettledReceipts,
  createReceiptOutboxController,
  intentHasPendingReceipt,
  persistReceiptDocument,
  queueExecutionReceipt,
  recordExecutionSubmissionEvent,
  recordOperationSubmissionEvent,
  receiptOutboxHasCapacity,
  settleReceiptOutbox,
} from "./receipt-source.mjs";

const HASH = `0x${"12".repeat(32)}`;
const ITEM = {
  source: "relay",
  relayId: "123e4567-e89b-42d3-a456-426614174000",
  kind: "trigger",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    nonce: 7n,
  },
};

function chain(head = 20n, blockNumber = 10n) {
  return {
    getBlockNumber: async () => head,
    getTransactionReceipt: async () => ({
      blockNumber,
      blockHash: `0x${"34".repeat(32)}`,
      status: "success",
      transactionIndex: 1,
      gasUsed: 123n,
      effectiveGasPrice: 2n,
    }),
    getTransaction: async () => ({ from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }),
    getBlock: async () => ({ hash: `0x${"34".repeat(32)}`, timestamp: 1_785_000_000n }),
  };
}

test("receipt outbox persists a local document and clears only after hosted idempotent upsert", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  let posts = 0;
  const result = await settleReceiptOutbox({
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () => {
      posts += 1;
      return new Response(JSON.stringify({ stored: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.settled.length, 1);
  assert.equal(posts, 1);
  assert.deepEqual(state.receiptOutbox, {});
  const files = readdirSync(receiptsDir);
  assert.equal(files.length, 1);
  const document = JSON.parse(readFileSync(join(receiptsDir, files[0]), "utf8"));
  assert.equal(document.outcome, "finalized");
  assert.equal(document.authorityScope, "none");
});

test("a non-final receipt remains queued and never calls the hosted API", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-pending-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  let posts = 0;
  const result = await settleReceiptOutbox({
    publicClient: chain(10n, 10n),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () => {
      posts += 1;
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(result.pending.length, 1);
  assert.equal(posts, 0);
  assert.ok(state.receiptOutbox[HASH]);
});

test("a receipt from a non-canonical block remains pending through a reorg", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-reorg-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  let posts = 0;
  const reorgedChain = {
    ...chain(),
    getBlock: async () => ({ hash: `0x${"99".repeat(32)}`, timestamp: 1_785_000_000n }),
  };

  const result = await settleReceiptOutbox({
    publicClient: reorgedChain,
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () => {
      posts += 1;
      return new Response(null, { status: 201 });
    },
  });

  assert.equal(result.settled.length, 0);
  assert.equal(result.pending.length, 1);
  assert.match(state.receiptOutbox[HASH].lastError, /does not match canonical block.*possible reorg/);
  assert.equal(posts, 0);
  assert.deepEqual(readdirSync(receiptsDir), []);

  const restartedController = createReceiptOutboxController(state, async () => {});
  assert.equal(restartedController.admission().allowed, false);
  assert.equal(restartedController.admission().outcome, "nonce-lane-pending");

  const canonical = await settleReceiptOutbox({
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () => {
      posts += 1;
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(canonical.settled.length, 1);
  assert.equal(restartedController.admission().allowed, true);
  assert.equal(posts, 1);
});

test("earnings advance only from canonically settled successful receipts", () => {
  const state = { earnings: { runs: 4, conversions: 2 } };
  accountSettledReceipts(state, [
    { txHash: `0x${"01".repeat(32)}`, kind: "recurring", outcome: "finalized" },
    { txHash: `0x${"02".repeat(32)}`, kind: "trigger", outcome: "reverted" },
    { txHash: `0x${"03".repeat(32)}`, kind: "pot-conversion", outcome: "finalized" },
  ]);
  assert.deepEqual(state.earnings, { runs: 5, conversions: 3 });
});

test("receipt publication is idempotent but refuses an existing conflicting identity", () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-conflict-"));
  const document = {
    receiptVersion: 1,
    source: "onchain",
    chainId: 4663,
    txHash: HASH,
    relayIntentId: ITEM.relayId,
    zap: ITEM.intent.zap,
    kind: ITEM.kind,
    nonce: "7",
    outcome: "finalized",
    blockNumber: "10",
    blockHash: `0x${"34".repeat(32)}`,
  };

  assert.equal(persistReceiptDocument(receiptsDir, document).created, true);
  assert.equal(persistReceiptDocument(receiptsDir, { ...document }).created, false);
  assert.throws(
    () =>
      persistReceiptDocument(receiptsDir, {
        ...document,
        zap: "0x1111111111111111111111111111111111111111",
      }),
    /conflicts on immutable field zap/,
  );
});

test("a queued transaction suppresses the same authorization after a state-file restart", () => {
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  const restarted = JSON.parse(JSON.stringify(state));

  assert.equal(intentHasPendingReceipt(restarted, ITEM), true);
  assert.equal(
    intentHasPendingReceipt(restarted, {
      ...ITEM,
      intent: { ...ITEM.intent, nonce: 8n },
    }),
    false,
  );
});

test("the execution receipt outbox is capped before another broadcast can be admitted", () => {
  const state = {
    receiptOutbox: Object.fromEntries(
      Array.from({ length: RECEIPT_OUTBOX_LIMIT }, (_, index) => [
        `existing-${index}`,
        { zap: ITEM.intent.zap, kind: ITEM.kind, nonce: String(index) },
      ]),
    ),
  };

  assert.equal(receiptOutboxHasCapacity(state), false);
  assert.throws(
    () => queueExecutionReceipt(state, { ...ITEM, intent: { ...ITEM.intent, nonce: 999n } }, HASH),
    /safety limit/,
  );
});

test("an outbox persistence failure opens a fail-closed broadcast circuit for the process", async () => {
  const state = {};
  const controller = createReceiptOutboxController(state, async () => {
    throw new Error("disk full");
  });

  assert.deepEqual(controller.admission(), { allowed: true });
  await assert.rejects(() => controller.record(ITEM, HASH), /broadcast circuit is now open/);
  assert.ok(state.receiptOutbox[HASH], "the in-memory evidence remains available to this process");
  const admission = controller.admission();
  assert.equal(admission.allowed, false);
  assert.equal(admission.outcome, "receipt-persistence-halted");
  assert.match(admission.detail, /disk full/);
  assert.match(admission.detail, /repair state storage and restart/);
});

test("prepared raw bytes are hash-bound, durable, and transition to submitted evidence", async () => {
  const raw = "0x0201";
  const hash = keccak256(raw);
  const persisted = [];
  const state = {};
  const controller = createReceiptOutboxController(state, async (nextState) => {
    persisted.push(JSON.parse(JSON.stringify(nextState)));
  });
  await controller.recordPrepared(ITEM, hash, raw);
  assert.equal(state.receiptOutbox[hash].submissionState, "prepared");
  assert.equal(state.receiptOutbox[hash].serializedTransaction, raw);
  assert.equal(persisted.length, 1);

  await controller.markSubmitted(hash, {
    mode: "private-multi-relay",
    status: "accepted-quorum",
    requiredDistinctOrigins: 2,
    attemptedOrigins: 2,
    acceptedOrigins: 2,
    unknownOrigins: 0,
    rejectedOrigins: 0,
    endpoints: [
      {
        id: "relay-a",
        origin: "https://relay-a.example",
        operator: "operator-a",
        classification: "private-relay",
        status: "accepted",
        latencyMs: 10,
        detail: "accepted",
      },
    ],
  });
  assert.equal(state.receiptOutbox[hash].submissionState, "submitted");
  assert.equal(state.receiptOutbox[hash].privateSubmission.acceptedOrigins, 2);
  assert.equal(persisted.length, 2);
  assert.ok(
    !JSON.stringify(state.receiptOutbox[hash].privateSubmission).includes(raw),
    "relay health evidence must not copy raw transaction bytes",
  );
});

test("final receipt preserves sanitized private relay evidence and inclusion, never signed bytes", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-private-receipt-"));
  const raw = "0x0205";
  const hash = keccak256(raw);
  const authorization = "Bearer receipt-must-not-contain-this-secret";
  const state = {};
  const controller = createReceiptOutboxController(state, async () => {});

  await controller.recordPrepared(ITEM, hash, raw);
  await controller.markSubmitted(hash, {
    mode: "private-multi-relay",
    status: "accepted-quorum",
    requiredDistinctOrigins: 2,
    attemptedOrigins: 2,
    acceptedOrigins: 2,
    unknownOrigins: 0,
    rejectedOrigins: 0,
    authorization,
    rawTransaction: raw,
    endpoints: [
      {
        id: "relay-a",
        origin: "https://relay-a.example",
        url: "https://relay-a.example/rpc?credential=must-not-survive",
        operator: "operator-a",
        classification: "private-relay",
        status: "accepted",
        latencyMs: 10,
        detail: "accepted",
        authorization,
      },
    ],
  });

  const result = await settleReceiptOutbox({
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "", chainId: 4663 },
  });

  assert.equal(result.settled.length, 1);
  assert.deepEqual(state.receiptOutbox, {});
  const [file] = readdirSync(receiptsDir);
  const serializedDocument = readFileSync(join(receiptsDir, file), "utf8");
  const document = JSON.parse(serializedDocument);
  assert.equal(document.privateSubmission.status, "accepted-quorum");
  assert.equal(document.privateSubmission.acceptedOrigins, 2);
  assert.equal(document.privateSubmission.inclusion, "finalized");
  assert.equal(document.privateSubmission.endpoints[0].origin, "https://relay-a.example");
  assert.ok(!Object.hasOwn(document, "serializedTransaction"));
  assert.ok(!serializedDocument.includes(raw));
  assert.ok(!serializedDocument.includes(authorization));
  assert.ok(!serializedDocument.includes("credential=must-not-survive"));
});

test("prepared journal rejects raw bytes that do not match the claimed hash", async () => {
  const controller = createReceiptOutboxController({}, async () => {});
  await assert.rejects(
    () => controller.recordPrepared(ITEM, HASH, "0x0201"),
    /does not match its deterministic hash/,
  );
});

test("execution and maintenance callbacks preserve prepare then submit phases end to end", async () => {
  const executionRaw = "0x0203";
  const executionHash = keccak256(executionRaw);
  const operationRaw = "0x0204";
  const operationHash = keccak256(operationRaw);
  const state = {};
  const snapshots = [];
  const controller = createReceiptOutboxController(state, async (nextState) => {
    snapshots.push(JSON.parse(JSON.stringify(nextState)));
  });
  await recordExecutionSubmissionEvent(controller, state, {
    hash: executionHash,
    item: ITEM,
    phase: "prepared",
    serializedTransaction: executionRaw,
  });
  assert.equal(state.receiptOutbox[executionHash].submissionState, "prepared");
  await recordExecutionSubmissionEvent(controller, state, {
    hash: executionHash,
    item: ITEM,
    phase: "submitted",
    privateSubmission: { status: "accepted-quorum", acceptedOrigins: 2 },
  });
  assert.equal(state.receiptOutbox[executionHash].submissionState, "submitted");

  const operation = {
    relayIntentId: null,
    zap: "0x0000000000000000000000000000000000000001",
    kind: "pot-conversion",
    nonce: operationHash,
  };
  await recordOperationSubmissionEvent(controller, state, operation, {
    hash: operationHash,
    phase: "prepared",
    serializedTransaction: operationRaw,
  });
  assert.equal(state.receiptOutbox[operationHash].submissionState, "prepared");
  await recordOperationSubmissionEvent(controller, state, operation, {
    hash: operationHash,
    phase: "submitted",
    privateSubmission: { status: "accepted-degraded", acceptedOrigins: 1 },
  });
  assert.equal(state.receiptOutbox[operationHash].submissionState, "submitted");
  assert.equal(snapshots.length, 4);
});

test("a permanent hosted rejection becomes durable dead-letter evidence", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-dead-letter-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);

  const result = await settleReceiptOutbox({
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "receipt does not match relay intent" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    now: () => 1_785_000_000_000,
  });

  assert.equal(result.settled.length, 1);
  assert.deepEqual(state.receiptOutbox, {});
  assert.deepEqual(state.receiptDeliveryOutbox, {});
  assert.equal(state.receiptDeadLetters[HASH].lastStatus, 422);
  assert.match(state.receiptDeadLetters[HASH].reason, /rejected permanently/);
  const files = readdirSync(receiptsDir);
  assert.equal(files.length, 2);
  assert.ok(files.some((name) => name.startsWith("dead-letter-4663-")));
});

test("an existing conflicting dead-letter file is surfaced instead of accepted", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-dead-letter-conflict-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  writeFileSync(
    join(receiptsDir, `dead-letter-4663-${HASH.toLowerCase()}.json`),
    `${JSON.stringify({
      receiptVersion: 1,
      source: "hosted-receipt-dead-letter",
      chainId: 4663,
      txHash: HASH,
      relayIntentId: ITEM.relayId,
      zap: "0x1111111111111111111111111111111111111111",
      kind: ITEM.kind,
      nonce: "7",
    })}\n`,
  );

  await settleReceiptOutbox({
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "receipt does not match relay intent" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    now: () => 1_785_000_000_000,
  });

  assert.match(state.receiptDeadLetters[HASH].lastError, /conflicts on immutable field zap/);
});

test("retryable hosted failures back off and later clear without retaining the execution outbox", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-retry-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  let posts = 0;
  let nowMs = 1_785_000_000_000;
  const fetchImpl = async () => {
    posts += 1;
    return posts === 1
      ? new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ stored: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
  };
  const args = {
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl,
    now: () => nowMs,
  };

  await settleReceiptOutbox(args);
  assert.equal(posts, 1);
  assert.deepEqual(state.receiptOutbox, {});
  assert.equal(state.receiptDeliveryOutbox[HASH].attempts, 1);
  const nextAttemptAt = state.receiptDeliveryOutbox[HASH].nextAttemptAt;
  assert.ok(nextAttemptAt > nowMs);

  await settleReceiptOutbox(args);
  assert.equal(posts, 1);
  assert.ok(state.receiptDeliveryOutbox[HASH]);

  nowMs = nextAttemptAt;
  await settleReceiptOutbox(args);
  assert.equal(posts, 2);
  assert.deepEqual(state.receiptDeliveryOutbox, {});
});

test("retryable hosted failures dead-letter after the bounded attempt budget", async () => {
  const receiptsDir = mkdtempSync(join(tmpdir(), "openzaps-receipts-retry-limit-"));
  const state = {};
  queueExecutionReceipt(state, ITEM, HASH);
  let nowMs = 1_785_000_000_000;
  const args = {
    publicClient: chain(),
    state,
    cfg: { confirmations: 3, receiptsDir, relayUrl: "https://relay.example", chainId: 4663 },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    now: () => nowMs,
  };

  await settleReceiptOutbox(args);
  for (let attempts = 1; attempts < HOSTED_DELIVERY_MAX_ATTEMPTS; attempts += 1) {
    nowMs = state.receiptDeliveryOutbox[HASH].nextAttemptAt;
    await settleReceiptOutbox(args);
  }

  assert.deepEqual(state.receiptDeliveryOutbox, {});
  assert.equal(state.receiptDeadLetters[HASH].attempts, HOSTED_DELIVERY_MAX_ATTEMPTS);
  assert.match(state.receiptDeadLetters[HASH].reason, /retry limit exhausted/);
});
