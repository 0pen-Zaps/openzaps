// Crash-safe execution receipt outbox. A transaction hash is queued immediately after broadcast,
// before the daemon waits for confirmations. Each finalized receipt is then written to a stable
// local JSON document and, for relayed intents, nominated to the hosted verifier. Both destinations
// are idempotent; neither receipt nor scorecard data grants execution authority.
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

export const RECEIPT_OUTBOX_LIMIT = 256;
export const RECEIPT_DELIVERY_OUTBOX_LIMIT = 256;
export const RECEIPT_DEAD_LETTER_LIMIT = 256;
export const RECEIPT_SETTLE_BATCH_LIMIT = 32;
export const HOSTED_DELIVERY_MAX_ATTEMPTS = 8;

const HOSTED_RETRY_BASE_MS = 15_000;
const HOSTED_RETRY_MAX_MS = 60 * 60_000;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

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

export function queueTransactionReceipt(state, entry, txHash) {
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
  const outbox = recordMap(state, "receiptOutbox");
  if (outbox[txHash]) return outbox[txHash];
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
  };
  return outbox[txHash];
}

export function queueExecutionReceipt(state, item, txHash) {
  return queueTransactionReceipt(state, receiptEntryForIntent(item), txHash);
}

/**
 * Couple hash admission to durable state persistence. Once persistence fails after a broadcast,
 * this process permanently opens the circuit: the already-broadcast transaction keeps its true
 * outcome, but no later wallet write is admitted until the operator repairs storage and restarts.
 */
export function createReceiptOutboxController(state, persist) {
  let persistenceFailure = null;
  const recordOperation = async (entry, txHash) => {
    try {
      queueTransactionReceipt(state, entry, txHash);
      await persist(state);
    } catch (error) {
      persistenceFailure ??= {
        at: new Date().toISOString(),
        message: error?.message ?? String(error),
      };
      throw new Error(
        `transaction ${txHash} was broadcast but receipt outbox persistence failed; `
          + "broadcast circuit is now open",
        { cause: error },
      );
    }
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
    async recordOperation(entry, txHash) {
      return recordOperation(entry, txHash);
    },
    get failure() {
      return persistenceFailure ? { ...persistenceFailure } : null;
    },
  };
}

/** fsync + rename produces one durable, machine-readable file per transaction. */
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
