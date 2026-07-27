// The v3 execution types: standing owner-signed authorizations the OpenZapV3 capsule enforces
// on-chain. This module is the app-side single source of truth for their EIP-712 shape, the
// executor fee economics, and the intent-file format the local Zap Executor daemon consumes —
// all three mirror `contracts/src/v3` exactly and are covered by executions.test.ts.
import type { Address, Hex, TypedDataDomain } from "viem";

/** Protocol fee on recurring/triggered output: 1% (100 bps). Mirrors OpenZapV3.EXEC_FEE_BPS. */
export const EXEC_FEE_BPS = 100n;
/** Executor's share of that fee: 80%. The other 20% funds the 0xZAPS lottery pot. */
export const EXECUTOR_SHARE_BPS = 8000n;
export const BPS = 10_000n;
/** Threshold ceiling accepted by the capsule (100x move). */
export const MAX_TRIGGER_THRESHOLD_BPS = 1_000_000n;
/** v3 clones sign under EIP-712 domain version "3" (v1 = "1", balance-relative v2 = "2"). */
export const OPENZAP_V3_DOMAIN_VERSION = "3";
/** v3.1 relative-floor clones sign under domain version "3.1". */
export const OPENZAP_V3_1_DOMAIN_VERSION = "3.1";
/** v3.2 stacking clones sign under domain version "3.2". */
export const OPENZAP_V3_2_DOMAIN_VERSION = "3.2";

/** One signature, up to `maxRuns` executions, at least `interval` seconds apart. */
export interface RecurringIntent {
  zap: Address;
  chainId: bigint;
  seriesId: bigint;
  validAfter: bigint;
  deadline: bigint;
  interval: bigint;
  /** uint32 on-chain; viem's typed-data mapping requires a JS number here. */
  maxRuns: number;
  recipient: Address;
  executor: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  policyHash: Hex;
  outAsset: Address;
  minOutPerRun: bigint;
}

/**
 * A recurring series whose per-run floor is computed from the price source's spot AT EXECUTION,
 * not an absolute number frozen at signing — so the floor never goes stale. Same shape as
 * `RecurringIntent` but `minOutPerRun` is replaced by `priceSource` + `maxSlippageBps`.
 */
export interface RecurringRelativeIntent {
  zap: Address;
  chainId: bigint;
  seriesId: bigint;
  validAfter: bigint;
  deadline: bigint;
  interval: bigint;
  /** uint32 on-chain; viem's typed-data mapping requires a JS number here. */
  maxRuns: number;
  recipient: Address;
  executor: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  policyHash: Hex;
  outAsset: Address;
  priceSource: Address;
  /** uint32 on-chain. The most below fair-spot a run may settle before it reverts. */
  maxSlippageBps: number;
}

/**
 * A relative-floor recurring series that ALSO buys 0xZAPS on every run. Same shape as
 * `RecurringRelativeIntent`, plus `stackPriceSource` + `stackBps`: each run diverts `stackBps` of its
 * post-fee output into 0xZAPS and stakes it to the lottery pot as the OWNER's tickets.
 *
 * The two extra fields are what make this its own signed type rather than a flag: diverting output is
 * a value movement, so it must be inside the signature, and a v3.1 signature must never be replayable
 * as a stacking one.
 */
export interface RecurringStackIntent {
  zap: Address;
  chainId: bigint;
  seriesId: bigint;
  validAfter: bigint;
  deadline: bigint;
  interval: bigint;
  /** uint32 on-chain; viem's typed-data mapping requires a JS number here. */
  maxRuns: number;
  recipient: Address;
  executor: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  policyHash: Hex;
  outAsset: Address;
  priceSource: Address;
  /** uint32 on-chain. Bands BOTH legs; must exceed EXEC_FEE_BPS or the capsule refuses the series. */
  maxSlippageBps: number;
  /** Prices `outAsset` -> 0xZAPS. Must be the zero address exactly when `outAsset` IS 0xZAPS. */
  stackPriceSource: Address;
  /** uint32 on-chain. Share of each run's post-fee output converted to 0xZAPS; 0 < stackBps < 10000. */
  stackBps: number;
}

/** One signature, ONE execution, valid only while the market is past the signed threshold. */
export interface TriggerIntent {
  zap: Address;
  chainId: bigint;
  nonce: bigint;
  validAfter: bigint;
  deadline: bigint;
  priceSource: Address;
  baselinePriceX96: bigint;
  /** uint32 on-chain; viem's typed-data mapping requires a JS number here. */
  thresholdBps: number;
  above: boolean;
  recipient: Address;
  executor: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  policyHash: Hex;
  outAsset: Address;
  minOut: bigint;
}

export const RECURRING_INTENT_TYPES = {
  RecurringIntent: [
    { name: "zap", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "seriesId", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "interval", type: "uint64" },
    { name: "maxRuns", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "executor", type: "address" },
    { name: "maxGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "outAsset", type: "address" },
    { name: "minOutPerRun", type: "uint256" },
  ],
} as const;

export const RECURRING_RELATIVE_INTENT_TYPES = {
  RecurringRelativeIntent: [
    { name: "zap", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "seriesId", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "interval", type: "uint64" },
    { name: "maxRuns", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "executor", type: "address" },
    { name: "maxGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "outAsset", type: "address" },
    { name: "priceSource", type: "address" },
    { name: "maxSlippageBps", type: "uint32" },
  ],
} as const;

export const RECURRING_STACK_INTENT_TYPES = {
  RecurringStackIntent: [
    { name: "zap", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "seriesId", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "interval", type: "uint64" },
    { name: "maxRuns", type: "uint32" },
    { name: "recipient", type: "address" },
    { name: "executor", type: "address" },
    { name: "maxGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "outAsset", type: "address" },
    { name: "priceSource", type: "address" },
    { name: "maxSlippageBps", type: "uint32" },
    { name: "stackPriceSource", type: "address" },
    { name: "stackBps", type: "uint32" },
  ],
} as const;

export const TRIGGER_INTENT_TYPES = {
  TriggerIntent: [
    { name: "zap", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "priceSource", type: "address" },
    { name: "baselinePriceX96", type: "uint256" },
    { name: "thresholdBps", type: "uint32" },
    { name: "above", type: "bool" },
    { name: "recipient", type: "address" },
    { name: "executor", type: "address" },
    { name: "maxGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "outAsset", type: "address" },
    { name: "minOut", type: "uint256" },
  ],
} as const;

export function openZapV3Domain(chainId: number | bigint, zap: Address): TypedDataDomain {
  return {
    name: "OpenZap",
    version: OPENZAP_V3_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: zap,
  };
}

/** EIP-712 domain for a v3.1 relative-floor capsule (version "3.1"). */
export function openZapV3_1Domain(chainId: number | bigint, zap: Address): TypedDataDomain {
  return {
    name: "OpenZap",
    version: OPENZAP_V3_1_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: zap,
  };
}

/** EIP-712 domain for a v3.2 stacking capsule (version "3.2"). */
export function openZapV3_2Domain(chainId: number | bigint, zap: Address): TypedDataDomain {
  return {
    name: "OpenZap",
    version: OPENZAP_V3_2_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: zap,
  };
}

/** Everything a wallet's `signTypedData` needs to authorize a 0xZAPS-stacking recurring series. */
export function buildRecurringStackTypedData(intent: RecurringStackIntent) {
  return {
    domain: openZapV3_2Domain(intent.chainId, intent.zap),
    types: RECURRING_STACK_INTENT_TYPES,
    primaryType: "RecurringStackIntent",
    message: intent,
  } as const;
}

/** Everything a wallet's `signTypedData` needs to authorize a relative-floor recurring series. */
export function buildRecurringRelativeTypedData(intent: RecurringRelativeIntent) {
  return {
    domain: openZapV3_1Domain(intent.chainId, intent.zap),
    types: RECURRING_RELATIVE_INTENT_TYPES,
    primaryType: "RecurringRelativeIntent",
    message: intent,
  } as const;
}

/** Everything a wallet's `signTypedData` needs to authorize a recurring series. */
export function buildRecurringTypedData(intent: RecurringIntent) {
  return {
    domain: openZapV3Domain(intent.chainId, intent.zap),
    types: RECURRING_INTENT_TYPES,
    primaryType: "RecurringIntent",
    message: intent,
  } as const;
}

/** Everything a wallet's `signTypedData` needs to arm a price trigger. */
export function buildTriggerTypedData(intent: TriggerIntent) {
  return {
    domain: openZapV3Domain(intent.chainId, intent.zap),
    types: TRIGGER_INTENT_TYPES,
    primaryType: "TriggerIntent",
    message: intent,
  } as const;
}

export interface ExecutorFeeSplit {
  /** 1% of the run's measured output. */
  fee: bigint;
  /** 80% of the fee — paid to whichever executor submitted the run. */
  executorCut: bigint;
  /** 20% of the fee — sent to the ZapLotteryPot, converted to 0xZAPS by a later permissionless `buyZaps` call. */
  potCut: bigint;
  /** What the recipient receives; the signed `minOut`/`minOutPerRun` floors THIS value. */
  net: bigint;
}

/** Integer-exact mirror of OpenZapV3._settleWithExecutorFee's arithmetic. */
export function computeExecutorFeeSplit(out: bigint): ExecutorFeeSplit {
  const fee = (out * EXEC_FEE_BPS) / BPS;
  const executorCut = (fee * EXECUTOR_SHARE_BPS) / BPS;
  const potCut = fee - executorCut;
  return { fee, executorCut, potCut, net: out - fee };
}

export interface StackSplit extends ExecutorFeeSplit {
  /** The slice of post-fee output converted to 0xZAPS and staked as the owner's tickets. */
  stackIn: bigint;
  /** What the recipient receives: post-fee output minus the stack slice. The floor gates THIS. */
  toRecipient: bigint;
}

/**
 * Integer-exact mirror of OpenZapV3_2._settleStack's arithmetic. The 1% protocol fee is carved first
 * — exactly as on every other executor path — and the stack slice is taken from what remains, so
 * stacking never changes what the executor or the pot earn from the fee itself.
 *
 * `net` is inherited from `ExecutorFeeSplit` and remains the POST-FEE figure so the two shapes stay
 * comparable; `toRecipient` is the post-fee-AND-post-slice amount the capsule floors.
 */
export function computeStackSplit(out: bigint, stackBps: number | bigint): StackSplit {
  const base = computeExecutorFeeSplit(out);
  const bps = BigInt(stackBps);
  const stackIn = (base.net * bps) / BPS;
  return { ...base, stackIn, toRecipient: base.net - stackIn };
}

/**
 * Whether a slippage band can ever be cleared. The capsule derives the floor from GROSS spot but
 * enforces it against a NET (post-fee) amount, so any band at or inside the 1% fee produces a series
 * that reverts on every run forever. v3.1 accepted such a band — a live series signed at exactly 100
 * bps could never execute; v3.2 rejects it with `SlippageBelowFee`, and this is the app-side mirror
 * that must keep the UI from ever offering one.
 */
export function slippageClearsFee(maxSlippageBps: number | bigint): boolean {
  const bps = BigInt(maxSlippageBps);
  return bps > EXEC_FEE_BPS && bps < BPS;
}

/** Whether a stack slice is one the capsule will accept (`InvalidStackBps` otherwise). */
export function isValidStackBps(stackBps: number | bigint): boolean {
  const bps = BigInt(stackBps);
  return bps > 0n && bps < BPS;
}

/** The price bound a trigger must cross, mirroring the capsule's integer math exactly. */
export function triggerBoundX96(baselinePriceX96: bigint, thresholdBps: number | bigint, above: boolean): bigint {
  const bps = BigInt(thresholdBps);
  return above ? (baselinePriceX96 * (BPS + bps)) / BPS : (baselinePriceX96 * (BPS - bps)) / BPS;
}

export function isTriggerArmed(
  priceX96: bigint,
  baselinePriceX96: bigint,
  thresholdBps: number | bigint,
  above: boolean,
): boolean {
  const bound = triggerBoundX96(baselinePriceX96, thresholdBps, above);
  return above ? priceX96 >= bound : priceX96 <= bound;
}

/** When the capsule will accept the series' next run (`0n` means: due now). */
export function nextRunAt(runs: bigint, lastRun: bigint, interval: bigint, validAfter: bigint): bigint {
  if (runs === 0n) return validAfter;
  return lastRun + interval;
}

/**
 * Serialize a signed standing intent into the JSON file the local Zap Executor daemon watches
 * (`~/.openzaps/executor/intents/*.json`). Bigints become decimal strings; the daemon re-validates
 * every field and the capsule re-verifies everything on-chain.
 */
export function serializeIntentFile(
  kind: "recurring" | "recurring-relative" | "recurring-stack" | "trigger",
  intent: RecurringIntent | RecurringRelativeIntent | RecurringStackIntent | TriggerIntent,
  signature: Hex,
): string {
  const plain: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(intent)) {
    plain[key] = typeof value === "bigint" || typeof value === "number" ? value.toString() : value;
  }
  return JSON.stringify({ kind, intent: plain, signature }, null, 2);
}
