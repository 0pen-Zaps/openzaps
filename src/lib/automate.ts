// Pure logic behind the Automate surface (/zap?view=automate): schedule presets, funding math,
// fee-aware floors, and intent drafting for the two v3 execution types. Everything here is
// deterministic and unit-tested; the console component only wires these to the wallet and RPC.
import type { Address, Hex } from "viem";

import {
  BPS,
  computeExecutorFeeSplit,
  type RecurringIntent,
  type RecurringRelativeIntent,
  type TriggerIntent,
} from "@/lib/executions";
import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";

export type AutomationMode = "recurring" | "trigger";

export interface IntervalPreset {
  id: string;
  label: string;
  seconds: bigint;
}

/** The cadences the UI offers. On-chain any interval >= 1s is valid; these are sane products. */
export const INTERVAL_PRESETS: readonly IntervalPreset[] = [
  { id: "hourly", label: "Every hour", seconds: 3_600n },
  { id: "6h", label: "Every 6 hours", seconds: 21_600n },
  { id: "daily", label: "Every day", seconds: 86_400n },
  { id: "weekly", label: "Every week", seconds: 604_800n },
] as const;

export interface ThresholdPreset {
  id: string;
  label: string;
  /** The user-facing move of the 0xZAPS price, in bps. NOT the feed-side threshold. */
  moveBps: number;
  /** True when the preset means "0xZAPS gains value". */
  rises: boolean;
}

/** Trigger presets, phrased as moves of the 0xZAPS price — the frame users think in. */
export const THRESHOLD_PRESETS: readonly ThresholdPreset[] = [
  { id: "up5", label: "0xZAPS rises +5%", moveBps: 500, rises: true },
  { id: "up10", label: "0xZAPS rises +10%", moveBps: 1_000, rises: true },
  { id: "up25", label: "0xZAPS rises +25%", moveBps: 2_500, rises: true },
  { id: "down5", label: "0xZAPS falls −5%", moveBps: 500, rises: false },
  { id: "down10", label: "0xZAPS falls −10%", moveBps: 1_000, rises: false },
  { id: "down25", label: "0xZAPS falls −25%", moveBps: 2_500, rises: false },
] as const;

/**
 * Convert a user-facing 0xZAPS price move into the condition the capsule actually checks.
 *
 * THE DIRECTION INVERSION LIVES HERE, ON PURPOSE, IN ONE PLACE. The live trigger feed
 * (`V4PoolPriceSource.priceX96`) is the Uniswap orientation: currency1 per currency0 =
 * 0xZAPS per aeWETH. When 0xZAPS GAINS value, one aeWETH buys FEWER 0xZAPS — the feed FALLS.
 * So "0xZAPS rises +x" must be signed as `above = false`, and the magnitude is reciprocal,
 * not mirrored: a +x move of the token is a x/(1+x) drop of the feed, and a −x move is a
 * x/(1−x) rise. (+10% ⇒ feed −9.09%; −10% ⇒ feed +11.11%.) Signing the naive direction
 * executes the OWNER'S TRADE ON THE OPPOSITE MARKET MOVE — the bug class this function and
 * its exact-value tests exist to make impossible.
 */
export function feedConditionForZapsMove(moveBps: number, rises: boolean): { above: boolean; thresholdBps: number } {
  const m = Math.trunc(moveBps);
  if (m <= 0) throw new Error("A trigger move must be a positive number of basis points.");
  if (!rises && m >= 10_000) throw new Error("A fall of 100% or more is not a price.");
  if (rises) {
    // Token +m ⇒ feed multiplies by 10000/(10000+m): a DROP of m/(10000+m).
    return { above: false, thresholdBps: Math.round((10_000 * m) / (10_000 + m)) };
  }
  // Token −m ⇒ feed multiplies by 10000/(10000−m): a RISE of m/(10000−m).
  return { above: true, thresholdBps: Math.round((10_000 * m) / (10_000 - m)) };
}

/**
 * Default slippage tolerance per mode. A recurring series signs ONE floor at creation that every
 * run must clear over hours or days, so a tight band bricks runs the moment the market drifts past
 * it (a 1% band reverts as soon as the output falls ~1% from the signing quote — an hour of normal
 * movement). A wider default keeps a series alive; a one-shot trigger, valid for a bounded window,
 * can stay tighter. This is a STOPGAP until the relative-floor capsule computes a fresh per-run
 * floor from spot at execution.
 */
export const DEFAULT_SLIPPAGE_BPS: Record<AutomationMode, number> = {
  recurring: 500, // 5%
  trigger: 200, // 2%
} as const;

export function defaultSlippageBps(mode: AutomationMode): number {
  return DEFAULT_SLIPPAGE_BPS[mode];
}

/** How much the capsule must hold before the automation can run to completion. */
export function requiredFunding(perRun: bigint, mode: AutomationMode, maxRuns: number): bigint {
  if (mode === "trigger") return perRun;
  if (maxRuns < 1) return 0n;
  return perRun * BigInt(maxRuns);
}

/**
 * The per-run floor the owner signs, derived from a fresh quote: apply the slippage tolerance,
 * then the 1% executor fee — because the capsule checks `minOut` NET of that fee. What comes out
 * of this function is what the recipient is guaranteed per run, or the run reverts.
 */
export function netFloorFromQuote(quotedOut: bigint, slippageBps: number): bigint {
  if (quotedOut <= 0n) return 0n;
  const bps = BigInt(Math.min(Math.max(Math.trunc(slippageBps), 0), 9_999));
  const grossFloor = (quotedOut * (10_000n - bps)) / 10_000n;
  return computeExecutorFeeSplit(grossFloor).net;
}

/** Q96 fixed-point scale, matching the pool's priceX96 encoding (currency1 per currency0). */
const Q96 = 1n << 96n;

/**
 * The per-run floor a v3.1 RELATIVE-floor recurring zap would enforce at a given spot — the
 * on-chain mirror of OpenZapV3_1._relativeFloor, byte-for-byte, so a preview can never overstate
 * the protection the owner actually signed. `priceX96` is currency1-per-currency0 (Q96); the input
 * asset is whichever pool currency is NOT the outAsset:
 *   outAsset == currency1 (buying c1 with c0): expected = amountIn * priceX96 / 2^96
 *   outAsset == currency0 (buying c0 with c1): expected = amountIn * 2^96 / priceX96
 * then floor = expected * (BPS - maxSlippageBps) / BPS. The contract enforces this NET of the 1%
 * fee, so the return value IS the minimum output the recipient is guaranteed each run.
 *
 * Returns 0n on every degenerate input — non-positive amount or price, a slippage outside the
 * capsule's [0, BPS) band, an outAsset the source can't value, or an expected output that floors to
 * zero (the contract fails closed here) — so callers render an explicit "—", never a false number.
 */
export function projectedRelativeFloor(input: {
  amountIn: bigint;
  outAsset: Address;
  currency0: Address;
  currency1: Address;
  priceX96: bigint;
  maxSlippageBps: number;
}): bigint {
  const { amountIn, outAsset, currency0, currency1, priceX96, maxSlippageBps } = input;
  if (amountIn <= 0n || priceX96 <= 0n) return 0n;
  const slip = BigInt(Math.trunc(maxSlippageBps));
  if (slip < 0n || slip >= BPS) return 0n; // >= 100% would disable the floor; the capsule reverts

  const out = outAsset.toLowerCase();
  let expected: bigint;
  if (out === currency1.toLowerCase()) {
    expected = (amountIn * priceX96) / Q96;
  } else if (out === currency0.toLowerCase()) {
    expected = (amountIn * Q96) / priceX96;
  } else {
    return 0n; // pair not valuable by this source
  }
  if (expected === 0n) return 0n; // contract reverts FloorUnderflow rather than pass any output
  return (expected * (BPS - slip)) / BPS;
}

export type FundingReadiness = { status: "unknown" | "sufficient" | "short"; shortfall: bigint };

/**
 * Whether the connected wallet can cover the transfer the Fund step is about to make. `needed` is the
 * amount that will actually LEAVE the wallet — the remaining funding target minus what the capsule
 * already holds — so a partially-funded zap only checks the gap. Returns:
 *   "unknown"    — balance hasn't read yet (null); never block the button or promise coverage on a
 *                  missing read, the on-chain transfer still checks for itself.
 *   "sufficient" — nothing owed (needed <= 0) or the wallet covers it.
 *   "short"      — wallet is below `needed`; `shortfall` is exactly how much more it must hold.
 */
export function fundingReadiness(walletBalance: bigint | null, needed: bigint): FundingReadiness {
  if (walletBalance === null) return { status: "unknown", shortfall: 0n };
  if (needed <= 0n) return { status: "sufficient", shortfall: 0n };
  if (walletBalance >= needed) return { status: "sufficient", shortfall: 0n };
  return { status: "short", shortfall: needed - walletBalance };
}

/**
 * Series end: enough room for every run at its cadence plus 25% headroom (executor latency,
 * chain congestion), never less than a day past the last theoretical run.
 */
export function suggestedSeriesDeadline(nowSec: bigint, intervalSec: bigint, maxRuns: number): bigint {
  const span = intervalSec * BigInt(Math.max(maxRuns, 1));
  const headroom = span / 4n > 86_400n ? span / 4n : 86_400n;
  return nowSec + span + headroom;
}

export interface RecurringDraftInput {
  zap: Address;
  chainId: number;
  seriesId: bigint;
  nowSec: bigint;
  interval: bigint;
  maxRuns: number;
  recipient: Address;
  policyHash: Hex;
  outAsset: Address;
  minOutPerRun: bigint;
}

export function draftRecurringIntent(input: RecurringDraftInput): RecurringIntent {
  return {
    zap: input.zap,
    chainId: BigInt(input.chainId),
    seriesId: input.seriesId,
    validAfter: 0n,
    deadline: suggestedSeriesDeadline(input.nowSec, input.interval, input.maxRuns),
    interval: input.interval,
    maxRuns: input.maxRuns,
    recipient: input.recipient,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: MAX_EXECUTION_GAS,
    maxFeePerGas: MAX_EXECUTION_FEE_PER_GAS,
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    minOutPerRun: input.minOutPerRun,
  };
}

export interface RecurringRelativeDraftInput {
  zap: Address;
  chainId: number;
  seriesId: bigint;
  nowSec: bigint;
  interval: bigint;
  maxRuns: number;
  recipient: Address;
  policyHash: Hex;
  outAsset: Address;
  priceSource: Address;
  maxSlippageBps: number;
}

/**
 * Draft a relative-floor recurring intent. Unlike the absolute-floor draft, this needs NO fresh
 * quote at signing: the capsule reads the oriented price source's spot on every run and floors the
 * output at `maxSlippageBps` below it — so the floor is always current. The user's slippage % IS
 * the signed tolerance.
 */
export function draftRecurringRelativeIntent(input: RecurringRelativeDraftInput): RecurringRelativeIntent {
  return {
    zap: input.zap,
    chainId: BigInt(input.chainId),
    seriesId: input.seriesId,
    validAfter: 0n,
    deadline: suggestedSeriesDeadline(input.nowSec, input.interval, input.maxRuns),
    interval: input.interval,
    maxRuns: input.maxRuns,
    recipient: input.recipient,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: MAX_EXECUTION_GAS,
    maxFeePerGas: MAX_EXECUTION_FEE_PER_GAS,
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    priceSource: input.priceSource,
    maxSlippageBps: Math.min(Math.max(Math.trunc(input.maxSlippageBps), 1), 9_999),
  };
}

export interface TriggerDraftInput {
  zap: Address;
  chainId: number;
  nonce: bigint;
  nowSec: bigint;
  validDays: number;
  priceSource: Address;
  baselinePriceX96: bigint;
  thresholdBps: number;
  above: boolean;
  recipient: Address;
  policyHash: Hex;
  outAsset: Address;
  minOut: bigint;
}

export function draftTriggerIntent(input: TriggerDraftInput): TriggerIntent {
  return {
    zap: input.zap,
    chainId: BigInt(input.chainId),
    nonce: input.nonce,
    validAfter: 0n,
    deadline: input.nowSec + BigInt(Math.max(input.validDays, 1)) * 86_400n,
    priceSource: input.priceSource,
    baselinePriceX96: input.baselinePriceX96,
    thresholdBps: input.thresholdBps,
    above: input.above,
    recipient: input.recipient,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: MAX_EXECUTION_GAS,
    maxFeePerGas: MAX_EXECUTION_FEE_PER_GAS,
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    minOut: input.minOut,
  };
}

/** Filename for the exported intent file the executor daemon consumes. */
export function intentFileName(mode: AutomationMode, zap: Address): string {
  return `openzap-${mode}-${zap.slice(2, 10).toLowerCase()}.json`;
}

/** Human line for a series' on-chain progress. */
export function describeSeries(runs: number, lastRun: bigint, intent: RecurringIntent, nowSec: bigint): string {
  if (runs === 0) return `0/${intent.maxRuns} runs — first run is available now`;
  if (runs >= intent.maxRuns) return `${intent.maxRuns}/${intent.maxRuns} runs — series complete`;
  const nextAt = lastRun + intent.interval;
  if (nowSec >= nextAt) return `${runs}/${intent.maxRuns} runs — next run is due now`;
  const waitMin = Number((nextAt - nowSec) / 60n) + 1;
  return `${runs}/${intent.maxRuns} runs — next run in ~${waitMin} min`;
}
