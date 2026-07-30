// The decision loop. For every stored intent the engine answers one question — "does the chain
// owe this run RIGHT NOW?" — by reading the same state the contract will enforce (series progress,
// nonce, price source). If yes it simulates, and only broadcasts when a signer is configured.
// Everything here is best-effort courier work: a wrong decision costs one reverted simulation,
// because the zap re-verifies cadence, condition, signature, and floors on-chain.
import { getAddress, zeroAddress } from "viem";
import { openZapV3Abi, priceSourceAbi } from "./abi.mjs";
import { privateSubmissionDetail } from "./private-submission.mjs";
import { verifyExecutionTargetProvenance } from "./provenance.mjs";
import {
  executorJsonReplacer,
  redactExecutorText,
} from "./redaction.mjs";

const BPS = 10_000n;
const MAX_THRESHOLD_BPS = 1_000_000n;
/** Modest tip (0.1 gwei), always capped by the intent/config fee ceiling. */
const PRIORITY_FEE_WEI = 100_000_000n;

export function log(level, msg, extra) {
  const safeMessage = redactExecutorText(msg, {
    fallback: "executor diagnostic unavailable",
  });
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${safeMessage}`;
  console.log(
    extra !== undefined
      ? `${line} ${JSON.stringify(extra, executorJsonReplacer)}`
      : line,
  );
}

/** @returns {{status:"due"|"waiting"|"blocked"|"finished"|"expired", detail:string}} */
export async function evaluateRecurring(client, item, nowSec) {
  const { intent } = item;
  if (await client.readContract({ address: intent.zap, abi: openZapV3Abi, functionName: "nonceUsed", args: [intent.seriesId] })) {
    return { status: "finished", detail: "series consumed (exhausted or cancelled on-chain)" };
  }
  if (nowSec > intent.deadline) return { status: "expired", detail: `deadline ${intent.deadline} passed` };
  if (nowSec < intent.validAfter) return { status: "waiting", detail: `starts at ${intent.validAfter}` };

  const [runs, lastRun] = await client.readContract({
    address: intent.zap,
    abi: openZapV3Abi,
    functionName: "series",
    args: [intent.seriesId],
  });
  if (BigInt(runs) >= intent.maxRuns) return { status: "finished", detail: `all ${intent.maxRuns} runs done` };
  if (runs > 0) {
    const nextAt = BigInt(lastRun) + intent.interval;
    if (BigInt(nowSec) < nextAt) return { status: "waiting", detail: `run ${runs + 1}/${intent.maxRuns} due at ${nextAt}` };
  }
  return { status: "due", detail: `run ${runs + 1}/${intent.maxRuns} is owed` };
}

/** @returns {{status:"due"|"waiting"|"blocked"|"finished"|"expired", detail:string}} */
export async function evaluateTrigger(client, item, nowSec) {
  const { intent } = item;
  // Match the capsule's signed-trigger domain before cadence checks. A malformed authorization
  // is permanently blocked, even when its validAfter is still in the future, and must never reach
  // attacker-selected price-source reads or arithmetic.
  if (intent.baselinePriceX96 <= 0n) {
    return { status: "blocked", detail: "baselinePriceX96 must be greater than zero — malformed trigger" };
  }
  if (intent.thresholdBps <= 0n) {
    return { status: "blocked", detail: "thresholdBps must be greater than zero — malformed trigger" };
  }
  if (!intent.above && intent.thresholdBps >= BPS) {
    return { status: "blocked", detail: "below thresholdBps must be less than 10000 — malformed trigger" };
  }
  if (intent.thresholdBps > MAX_THRESHOLD_BPS) {
    return { status: "blocked", detail: "thresholdBps exceeds 1000000 — malformed trigger" };
  }
  if (await client.readContract({ address: intent.zap, abi: openZapV3Abi, functionName: "nonceUsed", args: [intent.nonce] })) {
    return { status: "finished", detail: "trigger consumed (fired or cancelled on-chain)" };
  }
  if (nowSec > intent.deadline) return { status: "expired", detail: `deadline ${intent.deadline} passed` };
  if (nowSec < intent.validAfter) return { status: "waiting", detail: `starts at ${intent.validAfter}` };

  let price;
  try {
    price = await client.readContract({ address: intent.priceSource, abi: priceSourceAbi, functionName: "priceX96" });
  } catch (err) {
    return { status: "blocked", detail: `price source unreadable (fails closed): ${err.shortMessage ?? err.message}` };
  }
  const bound = intent.above
    ? (intent.baselinePriceX96 * (BPS + intent.thresholdBps)) / BPS
    : (intent.baselinePriceX96 * (BPS - intent.thresholdBps)) / BPS;
  const armed = intent.above ? price >= bound : price <= bound;
  const pct = Number((price * 10_000n) / intent.baselinePriceX96) / 100 - 100;
  const detail = `price ${price} vs bound ${bound} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% from baseline)`;
  return armed ? { status: "due", detail: `armed — ${detail}` } : { status: "waiting", detail };
}

function intentTuple(item) {
  // viem encodes tuples from objects by component name; our parsed intent already matches.
  return item.intent;
}

/** Simulate, then (with a signer) broadcast one execution. Returns a submission record. */
const FUNCTION_BY_KIND = {
  recurring: "executeRecurring",
  "recurring-relative": "executeRecurringRelative",
  "recurring-stack": "executeRecurringStack",
  trigger: "executeTrigger",
};

export function executionSimulationParameters(item, account, blockNumber) {
  const functionName = FUNCTION_BY_KIND[item.kind];
  if (!functionName) throw new Error(`unsupported intent kind ${item.kind}`);
  return {
    address: item.intent.zap,
    abi: openZapV3Abi,
    functionName,
    args: [intentTuple(item), item.signature],
    account,
    gas: item.intent.maxGas < 10_000_000n ? item.intent.maxGas : 10_000_000n,
    ...(typeof blockNumber === "bigint" ? { blockNumber } : {}),
  };
}

export function classifySubmissionError(error) {
  const message = [error?.errorName, error?.shortMessage, error?.message].filter(Boolean).join(" ");
  return /ZeroBalanceRelativeStep|ERC20InsufficientBalance|insufficient (?:token )?balance|transfer amount exceeds balance|empty balance/i.test(
    message,
  )
    ? "underfunded"
    : "blocked";
}

/**
 * A signer with an unresolved nonce lane is unsafe to reuse: the unknown transaction may be an
 * execution whose outbox write was lost, or an external wallet write. RPC uncertainty also fails
 * closed because broadcasting without knowing the lane state can duplicate authority or wedge it.
 */
export async function checkNonceLane(publicClient, walletClient) {
  const address = walletClient?.account?.address;
  if (!address) {
    return { allowed: false, outcome: "nonce-lane-unknown", detail: "executor account is unavailable" };
  }
  let latest;
  let pending;
  try {
    [latest, pending] = await Promise.all([
      publicClient.getTransactionCount({ address, blockTag: "latest" }),
      publicClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
  } catch (error) {
    return {
      allowed: false,
      outcome: "nonce-lane-unknown",
      detail: `cannot prove executor nonce lane is clear: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    };
  }
  const latestNonce = BigInt(latest);
  const pendingNonce = BigInt(pending);
  if (pendingNonce > latestNonce) {
    return {
      allowed: false,
      outcome: "nonce-lane-pending",
      detail: `executor nonce lane has ${pendingNonce - latestNonce} unresolved transaction(s) `
        + `(latest ${latestNonce}, pending ${pendingNonce})`,
    };
  }
  if (pendingNonce < latestNonce) {
    return {
      allowed: false,
      outcome: "nonce-lane-unknown",
      detail: `executor nonce RPC views are inconsistent (latest ${latestNonce}, pending ${pendingNonce})`,
    };
  }
  return { allowed: true, latestNonce, pendingNonce };
}

export async function checkPendingBaseFee(publicClient, feeCap) {
  let block;
  try {
    block = await publicClient.getBlock({ blockTag: "pending" });
  } catch (error) {
    return {
      allowed: false,
      outcome: "fee-market-unknown",
      detail: `cannot read the pending base fee: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    };
  }
  if (block?.baseFeePerGas === null || block?.baseFeePerGas === undefined) {
    return {
      allowed: false,
      outcome: "fee-market-unknown",
      detail: "pending block did not report a base fee",
    };
  }
  const baseFee = BigInt(block.baseFeePerGas);
  const cap = BigInt(feeCap);
  if (baseFee > cap) {
    return {
      allowed: false,
      outcome: "gas-above-cap",
      detail: `pending base fee ${baseFee} > cap ${cap} — deferring (would not mine)`,
    };
  }
  return { allowed: true, baseFee, feeCap: cap };
}

/** FIFO async mutex used by every write path sharing the executor signer. */
export function createAsyncMutex() {
  let tail = Promise.resolve();
  return async function withLock(operation) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const turn = tail;
    tail = gate;
    await turn;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export async function submitExecution(
  publicClient,
  walletClient,
  item,
  cfg,
  onBroadcast = async () => {},
  verifyTarget = verifyExecutionTargetProvenance,
  canBroadcast = async () => ({ allowed: true }),
  withBroadcastLane = async (operation) => operation(),
) {
  const { intent, kind } = item;
  const functionName = FUNCTION_BY_KIND[kind];

  const pinned = getAddress(intent.executor) !== zeroAddress ? getAddress(intent.executor) : null;
  const self = walletClient ? walletClient.account.address : null;
  if (pinned && self && getAddress(self) !== pinned) {
    return { outcome: "skipped", detail: `intent pins executor ${pinned}; we are ${self}` };
  }

  try {
    // The relay is discovery, not trust. Prove the target is an exact canonical
    // factory clone before even simulating attacker-controlled calldata.
    await verifyTarget(publicClient, item, cfg);
  } catch (err) {
    return { outcome: "blocked", detail: `capsule provenance failed: ${err.shortMessage ?? err.message}` };
  }

  const account = walletClient?.account ?? pinned ?? "0x000000000000000000000000000000000000dEaD";
  // The zap enforces `gasleft() <= intent.maxGas` at entry (anti-griefing, I-AUTH-4), so the tx
  // gas LIMIT must not exceed the signed cap — cap it, and cap the cap at a sane ceiling.
  const simulationParameters = executionSimulationParameters(item, account);
  let request;
  try {
    ({ request } = await publicClient.simulateContract(simulationParameters));
  } catch (err) {
    const outcome = classifySubmissionError(err);
    return { outcome, detail: `simulation failed: ${err.shortMessage ?? err.message}` };
  }

  if (!walletClient) {
    return { outcome: "watch-only", detail: `simulation OK — would submit ${functionName} (no signer configured)` };
  }

  const feeCap = intent.maxFeePerGas < cfg.maxFeePerGasWei ? intent.maxFeePerGas : cfg.maxFeePerGasWei;
  try {
    const laneResult = await withBroadcastLane(async () => {
      let admission;
      try {
        admission = await canBroadcast(item);
      } catch (error) {
        return {
          deferred: {
            outcome: "broadcast-admission-unknown",
            detail: `pre-broadcast safety gate failed closed: ${error?.shortMessage ?? error?.message ?? String(error)}`,
          },
        };
      }
      if (
        admission === false
        || (admission && typeof admission === "object" && admission.allowed === false)
      ) {
        return {
          deferred: {
            outcome: admission?.outcome ?? "broadcast-deferred",
            detail: admission?.detail ?? "pre-broadcast safety gate deferred this transaction",
          },
        };
      }

      // simulateContract runs eth_call at gasprice 0, so the live pending base fee must be checked
      // inside the signer-lane lock immediately before the send. RPC uncertainty fails closed.
      const feeAdmission = await checkPendingBaseFee(publicClient, feeCap);
      if (!feeAdmission.allowed) return { deferred: feeAdmission };

      let hash;
      let preparedOutbox = false;
      try {
        // Explicit priority fee capped by the fee ceiling: without it, a node-suggested tip above
        // the cap makes viem reject the request and the submission stalls forever.
        const priority = feeCap < PRIORITY_FEE_WEI ? feeCap : PRIORITY_FEE_WEI;
        const privateSubmission = walletClient.openZapsPrivateSubmission;
        const privateFields = {};
        if (privateSubmission?.withPreparationHook) {
          const admittedNonce = admission?.latestNonce;
          if (
            typeof admittedNonce !== "bigint"
            || admittedNonce < 0n
            || admittedNonce > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            return {
              deferred: {
                outcome: "nonce-lane-unknown",
                detail: "private submission requires the exact admitted pending nonce",
              },
            };
          }
          // Supplying every signing field prevents viem from attempting eth_fillTransaction,
          // eth_estimateGas, or another transaction-shaped call through the read transport.
          Object.assign(privateFields, {
            chainId: cfg.chainId,
            nonce: Number(admittedNonce),
            type: "eip1559",
          });
        }
        const write = () => walletClient.writeContract({
          ...request,
          ...privateFields,
          maxFeePerGas: feeCap,
          maxPriorityFeePerGas: priority,
        });
        hash = privateSubmission?.withPreparationHook
          ? await privateSubmission.withPreparationHook(
              async ({ hash: preparedHash, serializedTransaction }) => {
                await onBroadcast({
                  hash: preparedHash,
                  item,
                  phase: "prepared",
                  serializedTransaction,
                });
                preparedOutbox = true;
              },
              write,
            )
          : await write();
      } catch (error) {
        return {
          deferred: {
            outcome: "broadcast-failed",
            detail: error?.shortMessage ?? error?.message ?? String(error),
          },
        };
      }

      let outboxWarning = "";
      try {
        if (preparedOutbox) {
          await onBroadcast({
            hash,
            item,
            phase: "submitted",
            privateSubmission:
              walletClient.openZapsPrivateSubmission?.getOutcome?.(hash) ?? null,
          });
        } else {
          // Legacy/test clients still persist immediately after their transport returns.
          await onBroadcast({ hash, item, phase: "submitted" });
        }
      } catch (error) {
        // The transaction already exists. Never mislabel this as a broadcast failure.
        outboxWarning = `; receipt outbox persistence failed: ${error?.shortMessage ?? error?.message}`;
      }
      return { hash, outboxWarning };
    });

    if (laneResult?.deferred) {
      return {
        outcome: laneResult.deferred.outcome,
        detail: laneResult.deferred.detail,
      };
    }
    if (!laneResult?.hash) {
      return {
        outcome: "broadcast-admission-unknown",
        detail: "signer-lane safety gate returned no broadcast result",
      };
    }
    const { hash, outboxWarning } = laneResult;
    const privateRelayOutcome =
      walletClient.openZapsPrivateSubmission?.getOutcome?.(hash) ?? null;
    const relayDetail = privateSubmissionDetail(privateRelayOutcome);
    const relaySuffix = relayDetail ? `; ${relayDetail}` : "";

    try {
      const confirmations = Number.isInteger(cfg.confirmations) ? cfg.confirmations : 1;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations,
        timeout: cfg.receiptTimeoutMs ?? 300_000,
      });
      return {
        outcome: "confirmation-observed",
        detail:
          `tx ${hash} receipt observed as ${receipt.status} at block ${receipt.blockNumber}; `
          + `awaiting canonical settlement${relaySuffix}${outboxWarning}`,
        txHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        confirmations,
        observedReceiptStatus: receipt.status,
        ...(privateRelayOutcome
          ? {
              privateSubmission: {
                ...privateRelayOutcome,
                inclusion: "receipt-observed",
              },
            }
          : {}),
      };
    } catch (error) {
      return {
        outcome: "confirmation-pending",
        detail:
          `tx ${hash} broadcast; finality wait pending: `
          + `${error?.shortMessage ?? error?.message ?? String(error)}${relaySuffix}${outboxWarning}`,
        txHash: hash,
        ...(privateRelayOutcome
          ? {
              privateSubmission: {
                ...privateRelayOutcome,
                inclusion: "pending",
              },
            }
          : {}),
      };
    }
  } catch (error) {
    return {
      outcome: "broadcast-admission-unknown",
      detail: `signer-lane safety gate failed closed: ${error?.shortMessage ?? error?.message ?? String(error)}`,
    };
  }
}

// A relative-floor series is scheduled identically to an absolute one — only the on-chain floor
// differs, and that is enforced by the capsule at execution, not decided by the executor.
const EVALUATORS = {
  recurring: evaluateRecurring,
  "recurring-relative": evaluateRecurring,
  "recurring-stack": evaluateRecurring,
  trigger: evaluateTrigger,
};

/**
 * Ordered worker pool for RPC-heavy evaluation. Results stay aligned with input order while no
 * more than `concurrency` promises are live, so a hostile relay cannot produce an RPC fan-out.
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * One full pass over the store. EVALUATION uses a small worker pool so reads overlap without
 * allowing unbounded RPC fan-out. SUBMISSION stays strictly sequential: one wallet means one nonce
 * lane, and parallel writeContract calls would race the nonce and reject each other. Returns
 * per-intent results for status/logging.
 */
export async function tick({
  publicClient,
  walletClient,
  cfg,
  intents,
  archive,
  onBroadcast,
  canBroadcast = () => true,
  withBroadcastLane,
}) {
  // The contract gates on block.timestamp, so "now" must be CHAIN time, not the wall clock —
  // the two can diverge (chain lag, or a warped local test chain).
  const nowSec = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

  const evaluated = await mapWithConcurrency(
    intents,
    cfg.evaluationConcurrency ?? 4,
    async (item) => {
      const label = `${item.kind}:${item.file}`;
      try {
        if (BigInt(item.intent.chainId) !== BigInt(cfg.chainId)) {
          return { item, label, result: { status: "blocked", detail: `intent chainId ${item.intent.chainId} != ${cfg.chainId}` } };
        }
        return { item, label, result: await EVALUATORS[item.kind](publicClient, item, nowSec) };
      } catch (err) {
        return { item, label, result: { status: "error", detail: err.shortMessage ?? err.message } };
      }
    },
  );

  const results = [];
  for (const { item, label, result } of evaluated) {
    const identity = {
      zap: String(item.intent.zap),
      kind: item.kind,
      nonce: String(item.kind === "trigger" ? item.intent.nonce : item.intent.seriesId),
      relayIntentId: item.source === "relay" ? item.relayId ?? null : null,
    };
    try {
      if (result.status === "finished" || result.status === "expired") {
        const archived = archive(item, result.status);
        results.push({ label, ...identity, ...result, detail: `${result.detail} — archived to ${archived}` });
        continue;
      }
      if (result.status !== "due") {
        results.push({ label, ...identity, ...result });
        continue;
      }
      const submission = await submitExecution(
        publicClient,
        walletClient,
        item,
        cfg,
        onBroadcast,
        verifyExecutionTargetProvenance,
        canBroadcast,
        withBroadcastLane,
      );
      results.push({ label, ...identity, status: "due", ...submission });
    } catch (err) {
      results.push({ label, ...identity, status: "error", detail: err.shortMessage ?? err.message });
    }
  }
  return results;
}
