// The decision loop. For every stored intent the engine answers one question — "does the chain
// owe this run RIGHT NOW?" — by reading the same state the contract will enforce (series progress,
// nonce, price source). If yes it simulates, and only broadcasts when a signer is configured.
// Everything here is best-effort courier work: a wrong decision costs one reverted simulation,
// because the zap re-verifies cadence, condition, signature, and floors on-chain.
import { getAddress, zeroAddress } from "viem";
import { openZapV3Abi, priceSourceAbi } from "./abi.mjs";

const BPS = 10_000n;
/** Modest tip (0.1 gwei), always capped by the intent/config fee ceiling. */
const PRIORITY_FEE_WEI = 100_000_000n;

export function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  console.log(extra !== undefined ? `${line} ${JSON.stringify(extra, bigintsAsStrings)}` : line);
}

function bigintsAsStrings(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
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
export async function submitExecution(publicClient, walletClient, item, cfg) {
  const { intent, kind } = item;
  const functionName = kind === "recurring" ? "executeRecurring" : "executeTrigger";

  const pinned = getAddress(intent.executor) !== zeroAddress ? getAddress(intent.executor) : null;
  const self = walletClient ? walletClient.account.address : null;
  if (pinned && self && getAddress(self) !== pinned) {
    return { outcome: "skipped", detail: `intent pins executor ${pinned}; we are ${self}` };
  }

  const account = walletClient?.account ?? pinned ?? "0x000000000000000000000000000000000000dEaD";
  // The zap enforces `gasleft() <= intent.maxGas` at entry (anti-griefing, I-AUTH-4), so the tx
  // gas LIMIT must not exceed the signed cap — cap it, and cap the cap at a sane ceiling.
  const gasCeiling = 10_000_000n;
  const gas = intent.maxGas < gasCeiling ? intent.maxGas : gasCeiling;
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: intent.zap,
      abi: openZapV3Abi,
      functionName,
      args: [intentTuple(item), item.signature],
      account,
      gas,
    }));
  } catch (err) {
    return { outcome: "simulation-reverted", detail: err.shortMessage ?? err.message };
  }

  if (!walletClient) {
    return { outcome: "watch-only", detail: `simulation OK — would submit ${functionName} (no signer configured)` };
  }

  const feeCap = intent.maxFeePerGas < cfg.maxFeePerGasWei ? intent.maxFeePerGas : cfg.maxFeePerGasWei;
  try {
    // Explicit priority fee capped by the fee ceiling: without it, a node-suggested tip above the
    // cap makes viem reject the request and the submission stalls forever.
    const priority = feeCap < PRIORITY_FEE_WEI ? feeCap : PRIORITY_FEE_WEI;
    const hash = await walletClient.writeContract({ ...request, maxFeePerGas: feeCap, maxPriorityFeePerGas: priority });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return {
      outcome: receipt.status === "success" ? "executed" : "tx-reverted",
      detail: `tx ${hash} (${receipt.status}) block ${receipt.blockNumber}`,
      txHash: hash,
    };
  } catch (err) {
    return { outcome: "broadcast-failed", detail: err.shortMessage ?? err.message };
  }
}

const EVALUATORS = { recurring: evaluateRecurring, trigger: evaluateTrigger };

/** One full pass over the store. Returns per-intent results for status/logging. */
export async function tick({ publicClient, walletClient, cfg, intents, archive }) {
  // The contract gates on block.timestamp, so "now" must be CHAIN time, not the wall clock —
  // the two can diverge (chain lag, or a warped local test chain).
  const nowSec = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
  const results = [];
  for (const item of intents) {
    const label = `${item.kind}:${item.file}`;
    try {
      if (BigInt(item.intent.chainId) !== BigInt(cfg.chainId)) {
        results.push({ label, status: "blocked", detail: `intent chainId ${item.intent.chainId} != ${cfg.chainId}` });
        continue;
      }
      const evaluation = await EVALUATORS[item.kind](publicClient, item, nowSec);
      if (evaluation.status === "finished" || evaluation.status === "expired") {
        const archived = archive(item, evaluation.status);
        results.push({ label, ...evaluation, detail: `${evaluation.detail} — archived to ${archived}` });
        continue;
      }
      if (evaluation.status !== "due") {
        results.push({ label, ...evaluation });
        continue;
      }
      const submission = await submitExecution(publicClient, walletClient, item, cfg);
      results.push({ label, status: "due", ...submission });
    } catch (err) {
      results.push({ label, status: "error", detail: err.shortMessage ?? err.message });
    }
  }
  return results;
}
