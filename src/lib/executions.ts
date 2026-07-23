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
  /** 20% of the fee — sent to the ZapLotteryPot and converted to 0xZAPS. */
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
  kind: "recurring" | "trigger",
  intent: RecurringIntent | TriggerIntent,
  signature: Hex,
): string {
  const plain: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(intent)) {
    plain[key] = typeof value === "bigint" || typeof value === "number" ? value.toString() : value;
  }
  return JSON.stringify({ kind, intent: plain, signature }, null, 2);
}
