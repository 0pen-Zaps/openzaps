// Pure logic behind the Automate surface (/zap?view=automate): schedule presets, funding math,
// fee-aware floors, and intent drafting for the v3/v3.1/v3.2 standing-authorization lineages. Everything here is
// deterministic and unit-tested; the console component only wires these to the wallet and RPC.
import type { Address, Hex } from "viem";

import {
  BPS,
  computeExecutorFeeSplit,
  isValidStackBps,
  slippageClearsFee,
  type RecurringIntent,
  type RecurringRelativeIntent,
  type RecurringStackIntent,
  type TriggerIntent,
} from "@/lib/executions";
import { BOUNDED_SWAP_IDS } from "@/lib/chains";
import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";
import { readExecutionPolicyParams, type ExecutionPolicy } from "@/lib/execution-policy";

export type AutomationMode = "recurring" | "trigger";
/** Exact signed lineage. Recurring-relative and recurring-stack share schedule/funding semantics. */
export type AutomationIntentKind = "recurring-relative" | "recurring-stack" | "trigger";

export function automationModeForIntentKind(kind: AutomationIntentKind): AutomationMode {
  return kind === "trigger" ? "trigger" : "recurring";
}

export function isRecurringIntentKind(
  kind: AutomationIntentKind,
): kind is "recurring-relative" | "recurring-stack" {
  return kind !== "trigger";
}

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
  { id: "monthly", label: "Every 30 days", seconds: 2_592_000n },
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

export interface AutomationHandoffPreset {
  mode: AutomationMode;
  routeId: string;
  amount: string;
  slippageBps: number;
  intervalId: string;
  maxRuns: number;
  thresholdId: string;
  validDays: number | null;
  executionPolicy: ExecutionPolicy;
}

/** Validate a visual-builder handoff before it enters the live form. */
export function readAutomationHandoff(params: URLSearchParams): AutomationHandoffPreset | null {
  if (params.get("src") !== "build") return null;
  const mode = params.get("mode");
  const routeId = params.get("route") ?? "";
  const amount = params.get("amount") ?? "";
  const slippageBps = Number(params.get("bps"));
  const intervalId = params.get("interval") ?? "daily";
  const maxRuns = Number(params.get("runs") ?? "10");
  const thresholdId = params.get("threshold") ?? "up10";
  const daysParam = params.get("days");
  const validDays = daysParam === null ? null : Number(daysParam);
  const executionPolicy = readExecutionPolicyParams(params);

  if (mode !== "recurring" && mode !== "trigger") return null;
  if (!BOUNDED_SWAP_IDS.includes(routeId as (typeof BOUNDED_SWAP_IDS)[number])) return null;
  if (!/^\d+(?:\.\d{0,18})?$/.test(amount) || Number(amount) <= 0) return null;
  if (!Number.isInteger(slippageBps) || slippageBps < 5 || slippageBps > 500) return null;
  if (!INTERVAL_PRESETS.some((preset) => preset.id === intervalId)) return null;
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) return null;
  if (!THRESHOLD_PRESETS.some((preset) => preset.id === thresholdId)) return null;
  if (validDays !== null && ![7, 30, 90].includes(validDays)) return null;
  if (mode === "trigger" && validDays === null) return null;
  if (executionPolicy === null) return null;

  return { mode, routeId, amount, slippageBps, intervalId, maxRuns, thresholdId, validDays, executionPolicy };
}

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

/** Scale a relative floor to what the recipient actually receives after a signed stack slice. */
export function projectedStackRecipientFloor(relativeFloor: bigint, stackBps: number): bigint {
  if (relativeFloor <= 0n || !isValidStackBps(stackBps)) return 0n;
  return (relativeFloor * (BPS - BigInt(Math.trunc(stackBps)))) / BPS;
}

/** No executor pinned: any submitter may fire a run the capsule owes. */
export const OPEN_EXECUTOR = "0x0000000000000000000000000000000000000000" as const;

/**
 * Who is allowed to submit a run. `null`/undefined leaves the intent OPEN, which is
 * the liveness-maximizing default: whoever gets there first earns the executor's 80%
 * of the fee, and the capsule still refuses every run it does not owe. Pinning one
 * address is the trade a user makes when they want a specific executor (their own,
 * usually) — the capsule then reverts `ExecutorMismatch` for anyone else, so a pinned
 * executor going offline stalls the series until the owner submits it themselves.
 */
export function resolveExecutor(executor?: Address | null): Address {
  return executor ?? OPEN_EXECUTOR;
}

function executionBound(value: bigint | undefined, maximum: bigint, label: string): bigint {
  const resolved = value ?? maximum;
  if (resolved <= 0n || resolved > maximum) {
    throw new Error(`${label} must be greater than zero and no more than ${maximum.toString()}.`);
  }
  return resolved;
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
 * Confirm that a funding transaction both finalized successfully and reached the Zap's remaining
 * funding target at that exact block. Receipt status alone is insufficient because an ERC-20 can
 * return success without moving tokens.
 */
export async function verifyFundingConfirmation(input: {
  receiptStatus: "success" | "reverted";
  receiptBlockNumber: bigint;
  target: bigint;
  readBalance: (blockNumber: bigint) => Promise<bigint>;
}): Promise<bigint> {
  if (input.receiptStatus !== "success") {
    throw new Error("The funding transaction reverted. No tokens were deposited.");
  }
  const balance = await input.readBalance(input.receiptBlockNumber);
  if (balance < input.target) {
    throw new Error("The Zap balance did not reach its remaining-run funding target after confirmation.");
  }
  return balance;
}

export type WethFundingPlan = { status: "unknown" | "sufficient" | "short"; shortfall: bigint; wrapEth: bigint };

/**
 * Funding readiness for an aeWETH-denominated deposit, counting native ETH the app can wrap on the
 * user's behalf. `needed` is the aeWETH the Fund step will transfer. If the wallet's aeWETH already
 * covers it, no wrap. Otherwise the gap (`needed - wethBalance`) is wrappable from native ETH, but we
 * must leave `gasReserve` ETH so the wrap + transfer can still pay for gas — so the ETH actually
 * spendable on wrapping is `ethBalance - gasReserve`.
 *   "unknown"    — a balance needed for the decision has not read yet (never block on a missing read).
 *   "sufficient" — nothing owed, or aeWETH covers it (wrapEth 0), or ETH covers the gap (wrapEth = gap).
 *   "short"      — even wrapping every spendable wei leaves `shortfall` ETH missing.
 * `wrapEth` is the EXACT amount to wrap — never more than the gap, so the user is never over-wrapped.
 */
export function planWethFunding(input: {
  needed: bigint;
  wethBalance: bigint | null;
  ethBalance: bigint | null;
  gasReserve: bigint;
}): WethFundingPlan {
  const { needed, wethBalance, ethBalance, gasReserve } = input;
  if (needed <= 0n) return { status: "sufficient", shortfall: 0n, wrapEth: 0n };
  if (wethBalance === null) return { status: "unknown", shortfall: 0n, wrapEth: 0n };
  if (wethBalance >= needed) return { status: "sufficient", shortfall: 0n, wrapEth: 0n };

  const gap = needed - wethBalance;
  if (ethBalance === null) return { status: "unknown", shortfall: 0n, wrapEth: 0n };
  const spendableEth = ethBalance > gasReserve ? ethBalance - gasReserve : 0n;
  if (spendableEth >= gap) return { status: "sufficient", shortfall: 0n, wrapEth: gap };
  return { status: "short", shortfall: gap - spendableEth, wrapEth: 0n };
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
  /** Pin a single submitter, or omit to leave the run open to anyone. */
  executor?: Address | null;
  maxGas?: bigint;
  maxFeePerGas?: bigint;
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
    executor: resolveExecutor(input.executor),
    maxGas: executionBound(input.maxGas, MAX_EXECUTION_GAS, "Execution gas limit"),
    maxFeePerGas: executionBound(input.maxFeePerGas, MAX_EXECUTION_FEE_PER_GAS, "Gas price cap"),
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    minOutPerRun: input.minOutPerRun,
  };
}

export interface RecurringRelativeDraftInput {
  /** Pin a single submitter, or omit to leave the run open to anyone. */
  executor?: Address | null;
  maxGas?: bigint;
  maxFeePerGas?: bigint;
  zap: Address;
  chainId: number;
  seriesId: bigint;
  nowSec: bigint;
  interval: bigint;
  maxRuns: number;
  /** Optional explicit series expiry from the builder's execution-window guard. */
  validDays?: number | null;
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
  const explicitDeadline = input.validDays
    ? input.nowSec + BigInt(Math.max(Math.trunc(input.validDays), 1)) * 86_400n
    : null;
  const lastScheduledRun = input.nowSec + input.interval * BigInt(Math.max(input.maxRuns - 1, 0));
  if (explicitDeadline !== null && explicitDeadline < lastScheduledRun) {
    throw new Error("The series expiry ends before all scheduled runs can become due.");
  }
  return {
    zap: input.zap,
    chainId: BigInt(input.chainId),
    seriesId: input.seriesId,
    validAfter: 0n,
    deadline: explicitDeadline ?? suggestedSeriesDeadline(input.nowSec, input.interval, input.maxRuns),
    interval: input.interval,
    maxRuns: input.maxRuns,
    recipient: input.recipient,
    executor: resolveExecutor(input.executor),
    maxGas: executionBound(input.maxGas, MAX_EXECUTION_GAS, "Execution gas limit"),
    maxFeePerGas: executionBound(input.maxFeePerGas, MAX_EXECUTION_FEE_PER_GAS, "Gas price cap"),
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    priceSource: input.priceSource,
    maxSlippageBps: Math.min(Math.max(Math.trunc(input.maxSlippageBps), 1), 9_999),
  };
}

/** The stack sizes the UI offers, phrased as the share of each run that becomes 0xZAPS. */
export const STACK_PRESETS: readonly { id: string; label: string; bps: number }[] = [
  { id: "1", label: "1% of every run", bps: 100 },
  { id: "5", label: "5% of every run", bps: 500 },
  { id: "10", label: "10% of every run", bps: 1_000 },
  { id: "25", label: "25% of every run", bps: 2_500 },
] as const;

export interface RecurringStackDraftInput extends RecurringRelativeDraftInput {
  /** Prices `outAsset` -> 0xZAPS. Omit ONLY when `outAsset` already is 0xZAPS. */
  stackPriceSource?: Address | null;
  /** The 0xZAPS token address, so the draft can enforce the source/no-source rule the capsule checks. */
  zaps: Address;
  stackBps: number;
}

/**
 * Draft a 0xZAPS-stacking recurring intent: the relative-floor draft plus the signed slice.
 *
 * Three bounds are enforced HERE rather than left to the capsule, because a signature the capsule
 * will always reject is worse than an error — the user pays a wallet interaction for an authorization
 * that can never run:
 *   1. `stackBps` must be a real slice (the capsule reverts `InvalidStackBps` otherwise).
 *   2. `maxSlippageBps` must exceed the 1% fee, or every run reverts forever (`SlippageBelowFee`).
 *   3. `stackPriceSource` must be present exactly when a conversion leg exists — absent when the
 *      output already IS 0xZAPS, present when it is not (`StackSourceMismatch`).
 */
export function draftRecurringStackIntent(input: RecurringStackDraftInput): RecurringStackIntent {
  if (!isValidStackBps(input.stackBps)) {
    throw new Error("The 0xZAPS slice must be greater than 0% and less than 100% of each run.");
  }
  if (!slippageClearsFee(input.maxSlippageBps)) {
    throw new Error(
      "Slippage tolerance must be above 1% — the per-run floor is checked after the 1% protocol fee, " +
        "so a tighter band would block every run of the series.",
    );
  }
  const outIsZaps = input.outAsset.toLowerCase() === input.zaps.toLowerCase();
  const stackPriceSource = input.stackPriceSource ?? OPEN_EXECUTOR;
  const hasSource = stackPriceSource !== OPEN_EXECUTOR;
  if (outIsZaps && hasSource) {
    throw new Error("This zap already outputs 0xZAPS, so it needs no conversion price source.");
  }
  if (!outIsZaps && !hasSource) {
    throw new Error("A price source is required to floor the 0xZAPS conversion for this output asset.");
  }

  const base = draftRecurringRelativeIntent(input);
  return {
    ...base,
    stackPriceSource,
    stackBps: Math.trunc(input.stackBps),
  };
}

export interface TriggerDraftInput {
  /** Pin a single submitter, or omit to leave the run open to anyone. */
  executor?: Address | null;
  maxGas?: bigint;
  maxFeePerGas?: bigint;
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
    executor: resolveExecutor(input.executor),
    maxGas: executionBound(input.maxGas, MAX_EXECUTION_GAS, "Execution gas limit"),
    maxFeePerGas: executionBound(input.maxFeePerGas, MAX_EXECUTION_FEE_PER_GAS, "Gas price cap"),
    policyHash: input.policyHash,
    outAsset: input.outAsset,
    minOut: input.minOut,
  };
}

/** Filename for the exported intent file the executor daemon consumes. */
export function intentFileName(kind: AutomationIntentKind, zap: Address): string {
  return `openzap-${kind}-${zap.slice(2, 10).toLowerCase()}.json`;
}

/** Human line for a series' on-chain progress. */
export function describeSeries(
  runs: number,
  lastRun: bigint,
  intent: Pick<RecurringIntent, "maxRuns" | "interval">,
  nowSec: bigint,
): string {
  if (runs === 0) return `0/${intent.maxRuns} runs — first run is available now`;
  if (runs >= intent.maxRuns) return `${intent.maxRuns}/${intent.maxRuns} runs — series complete`;
  const nextAt = lastRun + intent.interval;
  if (nowSec >= nextAt) return `${runs}/${intent.maxRuns} runs — next run is due now`;
  const waitMin = Number((nextAt - nowSec) / 60n) + 1;
  return `${runs}/${intent.maxRuns} runs — next run in ~${waitMin} min`;
}
