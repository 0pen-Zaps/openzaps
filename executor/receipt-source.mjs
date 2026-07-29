// Crash-safe execution receipt outbox. A locally signed transaction is durably queued with its
// deterministic hash and exact bytes before the first private-relay request. Each finalized receipt
// is then written to a stable local JSON document and, for relayed intents, nominated to the hosted
// verifier. Both destinations are idempotent; neither receipt nor scorecard data grants authority.
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";

export const RECEIPT_OUTBOX_LIMIT = 256;
export const RECEIPT_DELIVERY_OUTBOX_LIMIT = 256;
export const RECEIPT_DEAD_LETTER_LIMIT = 256;
export const RECEIPT_SETTLE_BATCH_LIMIT = 32;
export const HOSTED_DELIVERY_MAX_ATTEMPTS = 8;

const HOSTED_RETRY_BASE_MS = 15_000;
const HOSTED_RETRY_MAX_MS = 60 * 60_000;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW_TRANSACTION = /^0x(?:[0-9a-fA-F]{2})+$/;

function intentNonce(item) {
  return String(item.kind === "trigger" ? item.intent.nonce : item.intent.seriesId);
}

function receiptEntryForIntent(item) {
  return {
    relayIntentId: item.source === "relay" ? item.relayId ?? null : null,
    zap: item.intent.zap,
    kind: item.kind,
    nonce: intentNonce(item),
  };
}

function recordMap(state, key) {
  const current = state[key];
  if (!current || typeof current !== "object" || Array.isArray(current)) state[key] = {};
  return state[key];
}

function receiptIdentityKey(zap, kind, nonce) {
  return `${String(zap).toLowerCase()}:${String(kind)}:${String(nonce)}`;
}

function fsyncDirectory(directory) {
  let directoryFd;
  try {
    directoryFd = openSync(directory, "r");
    fsyncSync(directoryFd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

function persistExclusiveDocument(target, body, directory, tag) {
  if (existsSync(target)) {
    fsyncDirectory(directory);
    return false;
  }
  const temporary = `${target}.${process.pid}.${tag}.tmp`;
  let fd;
  let published = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // Same-directory hard-link publication is atomic and never replaces an existing target.
      // Two processes may both create/fsync private temp files, but only one can link this name.
      linkSync(temporary, target);
      published = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      unlinkSync(temporary);
      fsyncDirectory(directory);
      return false;
    }
    unlinkSync(temporary);
    fsyncDirectory(directory);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original persistence failure.
      }
    }
    if (!published) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Preserve the original persistence failure.
      }
    }
    throw error;
  }
}

function existingDocument(target, expected, fields, label) {
  let document;
  try {
    document = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} ${target} exists but is not valid JSON`, { cause: error });
  }
  for (const field of fields) {
    const actualValue =
      typeof document?.[field] === "string" ? document[field].toLowerCase() : document?.[field];
    const expectedValue =
      typeof expected?.[field] === "string" ? expected[field].toLowerCase() : expected?.[field];
    if (actualValue !== expectedValue) {
      throw new Error(`${label} ${target} conflicts on immutable field ${field}`);
    }
  }
  return document;
}

export function pendingReceiptIdentitySet(state) {
  return new Set(
    Object.values(recordMap(state, "receiptOutbox"))
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => receiptIdentityKey(entry.zap, entry.kind, entry.nonce)),
  );
}

/** Restart-safe guard: state.json is enough to remember that this authorization already broadcast. */
export function intentHasPendingReceipt(state, item, pendingIdentities = pendingReceiptIdentitySet(state)) {
  return pendingIdentities.has(
    receiptIdentityKey(item.intent.zap, item.kind, intentNonce(item)),
  );
}

export function receiptOutboxHasCapacity(state) {
  return Object.keys(recordMap(state, "receiptOutbox")).length < RECEIPT_OUTBOX_LIMIT;
}

/** Account only canonically settled successes; observation-time receipts never reach this helper. */
export function accountSettledReceipts(state, settled) {
  state.earnings ??= { runs: 0, conversions: 0 };
  for (const receipt of settled) {
    if (receipt.outcome !== "finalized") continue;
    if (receipt.kind === "pot-conversion") state.earnings.conversions += 1;
    else state.earnings.runs += 1;
  }
  return state.earnings;
}

function validatedRawTransaction(serializedTransaction, txHash) {
  if (serializedTransaction === undefined || serializedTransaction === null) return null;
  if (
    typeof serializedTransaction !== "string"
    || !RAW_TRANSACTION.test(serializedTransaction)
  ) {
    throw new Error("prepared raw transaction is malformed");
  }
  if (keccak256(serializedTransaction).toLowerCase() !== txHash.toLowerCase()) {
    throw new Error("prepared raw transaction does not match its deterministic hash");
  }
  return serializedTransaction.toLowerCase();
}

function relayEvidence(outcome) {
  if (!outcome || typeof outcome !== "object") return null;
  return {
    mode: outcome.mode === "private-multi-relay" ? outcome.mode : "private-multi-relay",
    status: String(outcome.status ?? "unknown").slice(0, 64),
    requiredDistinctOrigins: Number(outcome.requiredDistinctOrigins ?? 0),
    attemptedOrigins: Number(outcome.attemptedOrigins ?? 0),
    acceptedOrigins: Number(outcome.acceptedOrigins ?? 0),
    unknownOrigins: Number(outcome.unknownOrigins ?? 0),
    rejectedOrigins: Number(outcome.rejectedOrigins ?? 0),
    endpoints: Array.isArray(outcome.endpoints)
      ? outcome.endpoints.slice(0, 8).map((endpoint) => ({
          id: String(endpoint?.id ?? "").slice(0, 64),
          origin: String(endpoint?.origin ?? "").slice(0, 256),
          operator: String(endpoint?.operator ?? "").slice(0, 96),
          classification: String(endpoint?.classification ?? "").slice(0, 32),
          status: String(endpoint?.status ?? "unknown").slice(0, 32),
          latencyMs: Number(endpoint?.latencyMs ?? 0),
          detail: String(endpoint?.detail ?? "").slice(0, 240),
        }))
      : [],
  };
}

export function queueTransactionReceipt(state, entry, txHash, options = {}) {
  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) {
    throw new Error("receipt outbox transaction hash is malformed");
  }
  if (
    !entry
    || typeof entry !== "object"
    || typeof entry.zap !== "string"
    || entry.zap.length === 0
    || typeof entry.kind !== "string"
    || entry.kind.length === 0
    || typeof entry.nonce !== "string"
    || entry.nonce.length === 0
  ) {
    throw new Error("receipt outbox transaction identity is malformed");
  }
  const serializedTransaction = validatedRawTransaction(options.serializedTransaction, txHash);
  const outbox = recordMap(state, "receiptOutbox");
  if (outbox[txHash]) {
    const existing = outbox[txHash];
    if (
      serializedTransaction
      && existing.serializedTransaction
      && existing.serializedTransaction.toLowerCase() !== serializedTransaction
    ) {
      throw new Error("receipt outbox already contains different raw bytes for this hash");
    }
    if (serializedTransaction && !existing.serializedTransaction) {
      existing.serializedTransaction = serializedTransaction;
      existing.submissionState = "prepared";
    }
    return existing;
  }
  if (Object.keys(outbox).length >= RECEIPT_OUTBOX_LIMIT) {
    throw new Error(`receipt outbox reached its ${RECEIPT_OUTBOX_LIMIT}-transaction safety limit`);
  }
  outbox[txHash] = {
    txHash,
    relayIntentId: entry.relayIntentId ?? null,
    zap: entry.zap,
    kind: entry.kind,
    nonce: entry.nonce,
    firstSeenAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    submissionState: serializedTransaction ? "prepared" : "submitted",
    serializedTransaction,
    lastPrivateDispatchAt: null,
    privateSubmission: null,
  };
  return outbox[txHash];
}

export function queueExecutionReceipt(state, item, txHash, options) {
  return queueTransactionReceipt(state, receiptEntryForIntent(item), txHash, options);
}

/**
 * Couple transaction preparation/submission to durable state persistence. A prepared transaction
 * is fsynced before private dispatch. If persistence later fails, this process permanently opens the
 * circuit and admits no later wallet write until the operator repairs storage and restarts.
 */
export function createReceiptOutboxController(state, persist) {
  let persistenceFailure = null;
  const persistOrOpenCircuit = async (txHash, action) => {
    try {
      await persist(state);
    } catch (error) {
      persistenceFailure ??= {
        at: new Date().toISOString(),
        message: error?.message ?? String(error),
      };
      throw new Error(
        `transaction ${txHash} ${action}, but receipt outbox persistence failed; `
          + "broadcast circuit is now open",
        { cause: error },
      );
    }
  };
  const recordOperation = async (entry, txHash) => {
    queueTransactionReceipt(state, entry, txHash);
    await persistOrOpenCircuit(txHash, "was broadcast");
  };
  const recordPreparedOperation = async (entry, txHash, serializedTransaction) => {
    queueTransactionReceipt(state, entry, txHash, { serializedTransaction });
    await persistOrOpenCircuit(txHash, "was prepared and was not dispatched");
  };
  const markSubmitted = async (txHash, outcome = null) => {
    const entry = recordMap(state, "receiptOutbox")[txHash];
    if (!entry) throw new Error(`prepared transaction ${txHash} is missing from the receipt outbox`);
    entry.submissionState = "submitted";
    entry.lastPrivateDispatchAt = new Date().toISOString();
    entry.lastError = null;
    entry.privateSubmission = relayEvidence(outcome);
    await persistOrOpenCircuit(txHash, "was submitted");
    return entry;
  };
  const recordDispatchFailure = async (txHash, error) => {
    const entry = recordMap(state, "receiptOutbox")[txHash];
    if (!entry) throw new Error(`prepared transaction ${txHash} is missing from the receipt outbox`);
    entry.submissionState = "prepared";
    entry.lastPrivateDispatchAt = new Date().toISOString();
    entry.lastError = String(error?.message ?? error ?? "private relay dispatch failed").slice(0, 500);
    await persistOrOpenCircuit(txHash, "remained prepared after private relay rejection");
    return entry;
  };
  return {
    admission() {
      if (persistenceFailure) {
        return {
          allowed: false,
          outcome: "receipt-persistence-halted",
          detail:
            `receipt outbox persistence circuit is open since ${persistenceFailure.at}: `
            + `${persistenceFailure.message}; repair state storage and restart the executor`,
        };
      }
      const pendingTransactions = Object.keys(recordMap(state, "receiptOutbox")).length;
      if (pendingTransactions > 0) {
        return {
          allowed: false,
          outcome: "nonce-lane-pending",
          detail:
            `durable receipt state has ${pendingTransactions} unresolved signer transaction(s); `
            + "deferring every wallet write until canonical receipt settlement",
        };
      }
      if (!receiptOutboxHasCapacity(state)) {
        return {
          allowed: false,
          outcome: "receipt-backlog",
          detail: "receipt outbox is full — deferring broadcast until pending transaction evidence settles",
        };
      }
      return { allowed: true };
    },
    async record(item, txHash) {
      return recordOperation(receiptEntryForIntent(item), txHash);
    },
    async recordPrepared(item, txHash, serializedTransaction) {
      return recordPreparedOperation(
        receiptEntryForIntent(item),
        txHash,
        serializedTransaction,
      );
    },
    async recordOperation(entry, txHash) {
      return recordOperation(entry, txHash);
    },
    async recordPreparedOperation(entry, txHash, serializedTransaction) {
      return recordPreparedOperation(entry, txHash, serializedTransaction);
    },
    markSubmitted,
    recordDispatchFailure,
    get failure() {
      return persistenceFailure ? { ...persistenceFailure } : null;
    },
  };
}

/** Route the engine's prepare/submit phases without allowing an index callback to discard raw bytes. */
export async function recordExecutionSubmissionEvent(controller, state, event) {
  const { hash, item, phase = "submitted", serializedTransaction, privateSubmission } = event;
  if (phase === "prepared") {
    return controller.recordPrepared(item, hash, serializedTransaction);
  }
  if (phase !== "submitted") {
    throw new Error(`unknown execution submission phase ${String(phase)}`);
  }
  if (state.receiptOutbox?.[hash]?.serializedTransaction) {
    return controller.markSubmitted(hash, privateSubmission);
  }
  return controller.record(item, hash);
}

/** Same phase router for maintenance writes, which have an operation identity instead of an intent. */
export async function recordOperationSubmissionEvent(controller, state, entry, event) {
  const { hash, phase = "submitted", serializedTransaction, privateSubmission } = event;
  if (phase === "prepared") {
    return controller.recordPreparedOperation(entry, hash, serializedTransaction);
  }
  if (phase !== "submitted") {
    throw new Error(`unknown operation submission phase ${String(phase)}`);
  }
  if (state.receiptOutbox?.[hash]?.serializedTransaction) {
    return controller.markSubmitted(hash, privateSubmission);
  }
  return controller.recordOperation(entry, hash);
}

/** Atomic no-replace publication produces one durable, machine-readable file per transaction. */
export function persistReceiptDocument(receiptsDir, document) {
  const target = join(receiptsDir, `${document.chainId}-${document.txHash.toLowerCase()}.json`);
  const created = persistExclusiveDocument(
    target,
    `${JSON.stringify(document, null, 2)}\n`,
    receiptsDir,
    Date.now(),
  );
  if (!created) {
    const existing = existingDocument(
      target,
      document,
      [
        "receiptVersion",
        "source",
        "chainId",
        "txHash",
        "relayIntentId",
        "zap",
        "kind",
        "nonce",
        "outcome",
        "blockNumber",
        "blockHash",
      ],
      "receipt document",
    );
    return { path: target, created: false, document: existing };
  }
  return { path: target, created: true, document };
}

async function nominateHostedReceipt(relayUrl, entry, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${relayUrl}/api/executions/receipts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: entry.txHash, relayIntentId: entry.relayIntentId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      recorded: false,
      retryable: true,
      status: null,
      retryAfterMs: null,
      error: error?.message ?? "hosted receipt request failed",
    };
  }
  if (response.ok) {
    return { recorded: true, retryable: false, status: response.status, retryAfterMs: null, error: null };
  }
  const body = await response.json().catch(() => null);
  const retryable =
    response.status === 408
    || response.status === 409
    || response.status === 425
    || response.status === 429
    || response.status >= 500;
  return {
    recorded: false,
    retryable,
    status: response.status,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    error: body?.error ?? `hosted receipt HTTP ${response.status}`,
  };
}

function retryAfterMs(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(HOSTED_RETRY_MAX_MS, Number(value) * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(HOSTED_RETRY_MAX_MS, timestamp - Date.now())) : null;
}

function hostedRetryDelay(attempts, providerDelay) {
  const exponential = Math.min(
    HOSTED_RETRY_MAX_MS,
    HOSTED_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)),
  );
  return Math.max(exponential, providerDelay ?? 0);
}

function deadLetterPath(receiptsDir, chainId, txHash) {
  return join(receiptsDir, `dead-letter-${chainId}-${txHash.toLowerCase()}.json`);
}

function persistDeadLetterDocument(receiptsDir, chainId, entry, reason, nowMs) {
  const document = {
    receiptVersion: 1,
    source: "hosted-receipt-dead-letter",
    chainId,
    txHash: entry.txHash,
    relayIntentId: entry.relayIntentId,
    zap: entry.zap,
    kind: entry.kind,
    nonce: entry.nonce,
    evidencePath: entry.evidencePath ?? null,
    attempts: entry.attempts,
    lastStatus: entry.lastStatus ?? null,
    lastError: entry.lastError ?? reason,
    reason,
    recordedAt: new Date(nowMs).toISOString(),
    authorityScope: "none",
  };
  const target = deadLetterPath(receiptsDir, chainId, entry.txHash);
  const created = persistExclusiveDocument(
    target,
    `${JSON.stringify(document, null, 2)}\n`,
    receiptsDir,
    nowMs,
  );
  if (!created) {
    existingDocument(
      target,
      document,
      ["receiptVersion", "source", "chainId", "txHash", "relayIntentId", "zap", "kind", "nonce"],
      "dead-letter document",
    );
  }
  return target;
}

function moveToReceiptDeadLetter(state, cfg, entry, reason, nowMs) {
  const deadLetters = recordMap(state, "receiptDeadLetters");
  let path = entry.evidencePath ?? null;
  try {
    path = persistDeadLetterDocument(cfg.receiptsDir, cfg.chainId, entry, reason, nowMs);
  } catch (error) {
    entry.lastError = `${entry.lastError ?? reason}; dead-letter file failed: ${error?.message ?? String(error)}`;
  }
  deadLetters[entry.txHash] = {
    txHash: entry.txHash,
    relayIntentId: entry.relayIntentId,
    zap: entry.zap,
    kind: entry.kind,
    nonce: entry.nonce,
    attempts: entry.attempts,
    lastStatus: entry.lastStatus ?? null,
    lastError: entry.lastError ?? reason,
    reason,
    evidencePath: path,
    deadLetteredAt: new Date(nowMs).toISOString(),
    authorityScope: "none",
  };
  while (Object.keys(deadLetters).length > RECEIPT_DEAD_LETTER_LIMIT) {
    const oldest = Object.keys(deadLetters)[0];
    if (!oldest) break;
    delete deadLetters[oldest];
  }
}

function enqueueHostedRetry(state, cfg, entry, failure, attempts, nowMs) {
  const deliveryOutbox = recordMap(state, "receiptDeliveryOutbox");
  const queued = {
    txHash: entry.txHash,
    relayIntentId: entry.relayIntentId,
    zap: entry.zap,
    kind: entry.kind,
    nonce: entry.nonce,
    evidencePath: entry.evidencePath ?? null,
    attempts,
    lastStatus: failure.status,
    lastError: failure.error,
    nextAttemptAt: nowMs + hostedRetryDelay(attempts, failure.retryAfterMs),
  };
  if (!failure.retryable) {
    moveToReceiptDeadLetter(state, cfg, queued, "hosted receipt rejected permanently", nowMs);
    return "dead-letter";
  }
  if (attempts >= HOSTED_DELIVERY_MAX_ATTEMPTS) {
    moveToReceiptDeadLetter(state, cfg, queued, "hosted receipt retry limit exhausted", nowMs);
    return "dead-letter";
  }
  if (!deliveryOutbox[entry.txHash] && Object.keys(deliveryOutbox).length >= RECEIPT_DELIVERY_OUTBOX_LIMIT) {
    moveToReceiptDeadLetter(state, cfg, queued, "hosted receipt delivery outbox is full", nowMs);
    return "dead-letter";
  }
  deliveryOutbox[entry.txHash] = queued;
  return "retry";
}

async function settleHostedDeliveries(state, cfg, fetchImpl, nowMs) {
  const deliveryOutbox = recordMap(state, "receiptDeliveryOutbox");
  const delivered = [];
  const deadLettered = [];
  const due = Object.entries(deliveryOutbox)
    .filter(([, entry]) => Number(entry.nextAttemptAt ?? 0) <= nowMs)
    .slice(0, RECEIPT_SETTLE_BATCH_LIMIT);
  for (const [hash, entry] of due) {
    const result = await nominateHostedReceipt(cfg.relayUrl, entry, fetchImpl);
    if (result.recorded) {
      delete deliveryOutbox[hash];
      delivered.push(entry);
      continue;
    }
    const disposition = enqueueHostedRetry(
      state,
      cfg,
      entry,
      result,
      Number(entry.attempts ?? 0) + 1,
      nowMs,
    );
    if (disposition === "dead-letter") {
      delete deliveryOutbox[hash];
      deadLettered.push(entry);
    }
  }
  return { delivered, deadLettered };
}

/**
 * Settle every queued hash. Missing/non-final receipts remain in the outbox; canonical finalized
 * receipts are persisted locally and release the one-outstanding signer lane. Hosted delivery
 * then retries from its own bounded, backed-off queue; permanent failures become durable dead
 * letters.
 */
export async function settleReceiptOutbox({ publicClient, state, cfg, fetchImpl = fetch, now = Date.now }) {
  const receiptOutbox = recordMap(state, "receiptOutbox");
  const settled = [];
  const pending = [];
  const nowMs = Number(now());
  const hosted = cfg.relayUrl
    ? await settleHostedDeliveries(state, cfg, fetchImpl, nowMs)
    : { delivered: [], deadLettered: [] };
  if (Object.keys(receiptOutbox).length === 0) return { settled, pending, hosted };
  const head = await publicClient.getBlockNumber();
  const requiredConfirmations = Number.isInteger(cfg.confirmations) ? cfg.confirmations : 1;

  for (const [hash, entry] of Object.entries(receiptOutbox).slice(0, RECEIPT_SETTLE_BATCH_LIMIT)) {
    entry.attempts = Number(entry.attempts ?? 0) + 1;
    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      entry.lastError = error?.shortMessage ?? error?.message ?? "receipt not found";
      pending.push(entry);
      continue;
    }
    const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
    if (confirmations < requiredConfirmations) {
      entry.lastError = `${confirmations}/${requiredConfirmations} confirmations`;
      pending.push(entry);
      continue;
    }

    try {
      const [transaction, block] = await Promise.all([
        publicClient.getTransaction({ hash }),
        publicClient.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      if (
        typeof block?.hash !== "string"
        || typeof receipt.blockHash !== "string"
        || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
      ) {
        throw new Error(
          `receipt block hash ${receipt.blockHash ?? "missing"} does not match canonical `
            + `block ${block?.hash ?? "missing"} at ${receipt.blockNumber}; possible reorg`,
        );
      }
      const document = {
        receiptVersion: 1,
        source: "onchain",
        chainId: cfg.chainId,
        txHash: hash,
        relayIntentId: entry.relayIntentId,
        zap: entry.zap,
        executor: transaction.from,
        kind: entry.kind,
        nonce: entry.nonce,
        outcome: receipt.status === "success" ? "finalized" : "reverted",
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        blockTime: new Date(Number(block.timestamp) * 1_000).toISOString(),
        transactionIndex: receipt.transactionIndex,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
        confirmations,
        recordedAt: new Date().toISOString(),
        authorityScope: "none",
        privateSubmission: entry.privateSubmission
          ? {
              ...relayEvidence(entry.privateSubmission),
              inclusion: receipt.status === "success" ? "finalized" : "reverted",
            }
          : null,
      };
      const local = persistReceiptDocument(cfg.receiptsDir, document);

      if (entry.relayIntentId && cfg.relayUrl) {
        const result = await nominateHostedReceipt(cfg.relayUrl, entry, fetchImpl);
        if (!result.recorded) {
          enqueueHostedRetry(
            state,
            cfg,
            { ...entry, evidencePath: local.path },
            result,
            1,
            nowMs,
          );
        }
      }

      delete receiptOutbox[hash];
      settled.push({ ...document, path: local.path });
    } catch (error) {
      entry.lastError = error?.shortMessage ?? error?.message ?? String(error);
      pending.push(entry);
    }
  }
  return { settled, pending, hosted };
}
