// The pot-conversion keeper and the executor's self-monitoring — the half of the executor economy
// that closes the loop. Recurring/triggered runs settle 20% of their 1% fee into the ZapLotteryPot;
// when that fee is denominated in aeWETH (a sell run), it just sits there until someone calls
// `pot.buyZaps` to convert it to 0xZAPS and credit the round's prize. `buyZaps` is permissionless,
// so the hosted executor performs it on a cadence — turning accrued fees into the 0xZAPS prize the
// UI already promises.
//
// The planning math lives here as PURE functions (unit-tested in keeper.test.mjs); engine-facing
// helpers that touch the chain wrap them. Nothing here can move user funds: the pot itself bounds
// buyZaps to one pinned adapter and the 0xZAPS output asset, so the worst a wrong plan does is
// waste one reverted simulation.
import { erc20Abi, lotteryPotAbi, priceSourceAbi } from "./abi.mjs";
import { log } from "./engine.mjs";

const BPS = 10_000n;
const Q96 = 1n << 96n;
/** Modest tip (0.1 gwei) — comfortably above Robinhood Chain's observed floor, far below the cap. */
const PRIORITY_FEE_WEI = 100_000_000n;

/**
 * Decide whether to convert the pot's accrued fee asset and, if so, the slippage-protected floor.
 *
 * `priceX96` is the V4PoolPriceSource orientation — 0xZAPS per aeWETH (currency1 per currency0) —
 * so for an aeWETH input the expected 0xZAPS out is `amountIn * priceX96 / 2^96`, floored by the
 * slippage tolerance to get `minZapsOut` (`buyZaps` reverts below it).
 *
 * WHAT THIS FLOOR DOES AND DOES NOT GUARANTEE. It is anchored to the SAME spot price the swap
 * executes against, so it protects against a STALE read and bounds passive slippage — but an
 * attacker who moves the pool before our read moves the floor with it, so it is NOT a defense
 * against active manipulation. That is accepted by design: only the pot's own accrued protocol
 * fee is ever at stake (never user funds — the pot can only pay 0xZAPS to a ticket holder),
 * conversions are dust-sized (>= convertMinWei), and sandwiching them costs more in pool fees and
 * gas than the spread is worth. If conversions ever grow past dust, replace this with a TWAP or
 * governance-signed floor before raising `convertMinWei`.
 *
 * @returns {{convert: boolean, reason: string, amountIn?: bigint, minZapsOut?: bigint, expected?: bigint}}
 */
export function planPotConversion({ feeBalance, priceX96, minConvertWei, slippageBps }) {
  if (feeBalance <= 0n) return { convert: false, reason: "pot holds no fee asset" };
  if (feeBalance < minConvertWei) {
    return { convert: false, reason: `below convert threshold (${feeBalance} < ${minConvertWei})` };
  }
  if (priceX96 <= 0n) return { convert: false, reason: "price source unreadable" };
  const bps = clampBps(slippageBps);
  const expected = (feeBalance * priceX96) / Q96;
  const minZapsOut = (expected * (BPS - bps)) / BPS;
  if (minZapsOut <= 0n) return { convert: false, reason: "expected 0xZAPS out rounds to zero" };
  return { convert: true, reason: "fee asset ready to convert", amountIn: feeBalance, minZapsOut, expected };
}

function clampBps(bps) {
  const n = Number.isFinite(bps) ? Math.trunc(bps) : 0;
  if (n < 0) return 0n;
  if (n > 9_999) return 9_999n;
  return BigInt(n);
}

/**
 * Classify the executor's own gas balance so a run of the wallet dry never happens silently.
 * `perRunWei` is a conservative estimate of what one submission costs; the wallet is "low" when it
 * can afford fewer than `warnRuns` more runs, "empty" when it cannot afford one.
 *
 * @returns {{level: "ok"|"low"|"empty", runsLeft: number}}
 */
export function gasHealth({ balanceWei, perRunWei, warnRuns }) {
  if (perRunWei <= 0n) return { level: "ok", runsLeft: Infinity };
  const runsLeft = Number(balanceWei / perRunWei);
  if (runsLeft < 1) return { level: "empty", runsLeft };
  if (runsLeft < warnRuns) return { level: "low", runsLeft };
  return { level: "ok", runsLeft };
}

/**
 * Read the pot's fee-asset balance + the live price, plan a conversion, and (with a signer) submit
 * `buyZaps`. Watch-only without a signer: it simulates and reports what it would convert. Returns a
 * record for logging/earnings. Never throws — a keeper failure must not take down the intent loop.
 */
export async function convertPotFees({ publicClient, walletClient, cfg }) {
  if (!cfg.lotteryPot || !cfg.poolPriceSource || !cfg.feeAsset) {
    return { outcome: "disabled", detail: "pot/price-source/fee-asset not configured" };
  }
  let feeBalance;
  let priceX96;
  try {
    [feeBalance, priceX96] = await Promise.all([
      publicClient.readContract({ address: cfg.feeAsset, abi: erc20Abi, functionName: "balanceOf", args: [cfg.lotteryPot] }),
      publicClient.readContract({ address: cfg.poolPriceSource, abi: priceSourceAbi, functionName: "priceX96" }),
    ]);
  } catch (err) {
    return { outcome: "read-failed", detail: err.shortMessage ?? err.message };
  }

  const plan = planPotConversion({
    feeBalance,
    priceX96,
    minConvertWei: cfg.convertMinWei,
    slippageBps: cfg.convertSlippageBps,
  });
  if (!plan.convert) return { outcome: "idle", detail: plan.reason };

  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: cfg.lotteryPot,
      abi: lotteryPotAbi,
      functionName: "buyZaps",
      args: [cfg.feeAsset, plan.amountIn, plan.minZapsOut],
      account: walletClient?.account ?? "0x000000000000000000000000000000000000dEaD",
    }));
  } catch (err) {
    return { outcome: "simulation-reverted", detail: err.shortMessage ?? err.message, amountIn: plan.amountIn };
  }

  if (!walletClient) {
    return {
      outcome: "watch-only",
      detail: `would convert ${plan.amountIn} fee-asset → ≥${plan.minZapsOut} 0xZAPS`,
      amountIn: plan.amountIn,
    };
  }

  try {
    const feeCap = cfg.maxFeePerGasWei;
    // Explicit priority fee capped by the fee cap: without it, a node-suggested priority tip above
    // the cap makes viem reject the request and every conversion stalls.
    const priority = feeCap < PRIORITY_FEE_WEI ? feeCap : PRIORITY_FEE_WEI;
    const hash = await walletClient.writeContract({ ...request, maxFeePerGas: feeCap, maxPriorityFeePerGas: priority });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return {
      outcome: receipt.status === "success" ? "converted" : "tx-reverted",
      detail: `buyZaps ${hash} (${receipt.status}) — ${plan.amountIn} fee-asset → ≥${plan.minZapsOut} 0xZAPS`,
      amountIn: plan.amountIn,
      minZapsOut: plan.minZapsOut,
      txHash: hash,
    };
  } catch (err) {
    return { outcome: "broadcast-failed", detail: err.shortMessage ?? err.message, amountIn: plan.amountIn };
  }
}

/**
 * Read the executor wallet's native balance and surface its health. In the loop (`announce`
 * omitted) it stays quiet unless the balance is LOW or EMPTY; for an explicit `status` check
 * (`announce = true`) it always logs the balance and runs-left, healthy or not.
 */
export async function checkGas({ publicClient, walletClient, cfg, announce = false }) {
  if (!walletClient) return { level: "watch-only", runsLeft: Infinity };
  let balanceWei;
  try {
    balanceWei = await publicClient.getBalance({ address: walletClient.account.address });
  } catch (err) {
    log("warn", `could not read executor gas balance: ${err.shortMessage ?? err.message}`);
    return { level: "unknown", runsLeft: NaN };
  }
  const health = gasHealth({ balanceWei, perRunWei: cfg.gasPerRunWei, warnRuns: cfg.gasWarnRuns });
  const runs = Number.isFinite(health.runsLeft) ? `~${Math.floor(health.runsLeft)} runs` : "unbounded";
  if (health.level === "empty") {
    log("error", `executor gas EMPTY: ${balanceWei} wei cannot fund one run — top up ${walletClient.account.address}`);
  } else if (health.level === "low") {
    log("warn", `executor gas LOW: ${runs} left (${balanceWei} wei) — top up ${walletClient.account.address}`);
  } else if (announce) {
    log("info", `executor gas OK: ${runs} left (${balanceWei} wei) at ${walletClient.account.address}`);
  }
  return { ...health, balanceWei };
}
