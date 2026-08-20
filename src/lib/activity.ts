import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import { matchesPolicyHaltCreation } from "@/lib/policy-halt";
import {
  ROBINHOOD_ASSETS,
  ROBINHOOD_TOKENS,
  configuredCapsuleLineageForFactory,
} from "@/lib/robinhood";

/** First ZapCreated is at block 15,971,673; scan from a safe floor below it. */
export const ACTIVITY_FROM_BLOCK = 15_900_000n;
/** Cap the feed; the stats always count the full history. */
export const ACTIVITY_FEED_LIMIT = 50;

export const zapCreatedEvent = {
  type: "event",
  name: "ZapCreated",
  inputs: [
    { name: "zap", type: "address", indexed: true },
    { name: "owner", type: "address", indexed: true },
    { name: "policyHash", type: "bytes32", indexed: false },
    { name: "implCodeHash", type: "bytes32", indexed: false },
    { name: "salt", type: "bytes32", indexed: false },
  ],
} as const;

export const executedEvent = {
  type: "event",
  name: "Executed",
  inputs: [
    { name: "nonce", type: "uint256", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "outAsset", type: "address", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "fee", type: "uint256", indexed: false },
  ],
} as const;

export const emergencyExitEvent = {
  type: "event",
  name: "EmergencyExit",
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

/** Exact one-way stop event emitted only by canonical v1.2 and v3.2 clones. */
export const policyHaltedEvent = {
  type: "event",
  name: "PolicyHalted",
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "policyHash", type: "bytes32", indexed: true },
  ],
} as const;

// ---------------------------------------------------------------------------
// Automated runs (v3 / v3.1 / v3.2). A recurring or triggered run does NOT emit the
// one-shot `Executed` event — it emits one of these — so a feed that only reads
// `Executed` shows an automated capsule as created-and-then-silent forever.
// ---------------------------------------------------------------------------

export const executedRecurringEvent = {
  type: "event",
  name: "ExecutedRecurring",
  inputs: [
    { name: "seriesId", type: "uint256", indexed: true },
    { name: "run", type: "uint32", indexed: false },
    { name: "executor", type: "address", indexed: true },
    { name: "outAsset", type: "address", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "executorFee", type: "uint256", indexed: false },
    { name: "potFee", type: "uint256", indexed: false },
  ],
} as const;

export const executedRecurringRelativeEvent = {
  type: "event",
  name: "ExecutedRecurringRelative",
  inputs: [
    { name: "seriesId", type: "uint256", indexed: true },
    { name: "run", type: "uint32", indexed: false },
    { name: "executor", type: "address", indexed: true },
    { name: "priceSource", type: "address", indexed: true },
    { name: "priceX96", type: "uint256", indexed: false },
    { name: "outAsset", type: "address", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "executorFee", type: "uint256", indexed: false },
    { name: "potFee", type: "uint256", indexed: false },
    { name: "floor", type: "uint256", indexed: false },
  ],
} as const;

export const executedRecurringStackEvent = {
  type: "event",
  name: "ExecutedRecurringStack",
  inputs: [
    { name: "seriesId", type: "uint256", indexed: true },
    { name: "run", type: "uint32", indexed: false },
    { name: "executor", type: "address", indexed: true },
    { name: "priceSource", type: "address", indexed: true },
    { name: "priceX96", type: "uint256", indexed: false },
    { name: "outAsset", type: "address", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "executorFee", type: "uint256", indexed: false },
    { name: "potFee", type: "uint256", indexed: false },
    { name: "floor", type: "uint256", indexed: false },
    { name: "stackIn", type: "uint256", indexed: false },
    { name: "zapsOut", type: "uint256", indexed: false },
  ],
} as const;

export const executedTriggerEvent = {
  type: "event",
  name: "ExecutedTrigger",
  inputs: [
    { name: "nonce", type: "uint256", indexed: true },
    { name: "executor", type: "address", indexed: true },
    { name: "priceSource", type: "address", indexed: false },
    { name: "priceX96", type: "uint256", indexed: false },
    { name: "outAsset", type: "address", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "executorFee", type: "uint256", indexed: false },
    { name: "potFee", type: "uint256", indexed: false },
  ],
} as const;

export interface CreatedLogInput {
  zap: Address;
  owner: Address;
  factory: Address;
  policyHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ExecutedLogInput {
  emitter: Address;
  recipient: Address;
  outAsset: Address;
  amountOut: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ExitLogInput {
  emitter: Address;
  owner: Address;
  asset: Address;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface PolicyHaltedLogInput {
  emitter: Address;
  owner: Address;
  policyHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

/** Which standing authorization produced an automated run. */
export type AutomatedRunKind = "recurring" | "recurring-relative" | "recurring-stack" | "trigger";

/**
 * One automated run, normalized across every standing-authorization event. `actor` is the
 * EXECUTOR that submitted it — the whole point of an automated run is that it
 * was not the owner — and `amountOut` is the net the recipient received, so it
 * is directly comparable to a one-shot `Executed`.
 */
export interface AutomatedRunLogInput {
  emitter: Address;
  kind: AutomatedRunKind;
  executor: Address;
  outAsset: Address;
  amountOut: bigint;
  executorFee: bigint;
  potFee: bigint;
  /** Post-fee output diverted from the recipient by a v3.2 stack run. */
  stackIn: bigint | null;
  /** 0xZAPS credited to the owner by that stack run. */
  zapsOut: bigint | null;
  /** seriesId for a recurring run, nonce for a trigger. */
  seriesId: bigint;
  /** 1-based run index within the series; null for a one-shot trigger. */
  run: number | null;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Every event an automated run can emit, paired with the kind it means.
 *
 * This list is the single source of truth for "what does automated history look
 * like on chain", and every reader that reports run history queries ALL of it.
 * A reader that queries a subset does not under-count by a little: an automated
 * capsule emits none of the other events, so a partial list reports a capsule
 * that has run twenty times as created-and-then-silent forever. That is exactly
 * how the capsule detail reader was wrong.
 */
export const AUTOMATED_RUN_EVENTS = [
  { event: executedRecurringEvent, kind: "recurring" },
  { event: executedRecurringRelativeEvent, kind: "recurring-relative" },
  { event: executedRecurringStackEvent, kind: "recurring-stack" },
  { event: executedTriggerEvent, kind: "trigger" },
] as const satisfies readonly { event: unknown; kind: AutomatedRunKind }[];

/**
 * One automated-run log as viem returns it, before normalization. The events
 * events do not share a field list — a trigger carries `nonce` where a recurring
 * series carries `seriesId` and a `run` index — so every arg is optional here
 * and `decodeAutomatedRuns` is what reconciles them into one shape.
 */
export interface AutomatedRunLog {
  address: Address;
  args?: {
    seriesId?: bigint;
    nonce?: bigint;
    run?: number;
    executor?: Address;
    outAsset?: Address;
    amountOut?: bigint;
    executorFee?: bigint;
    potFee?: bigint;
    stackIn?: bigint;
    zapsOut?: bigint;
  };
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Normalize one event's logs into the shared automated-run shape.
 *
 * A log missing any of the three fields that carry meaning — who submitted it,
 * what came out, and how much — is dropped rather than defaulted: a run whose
 * output cannot be read is not a run worth printing a number for.
 */
export function decodeAutomatedRuns(
  logs: readonly AutomatedRunLog[],
  kind: AutomatedRunKind,
): AutomatedRunLogInput[] {
  return logs.flatMap((log) => {
    const args = log.args;
    if (!args?.executor || !args.outAsset || args.amountOut === undefined) return [];
    if (kind === "recurring-stack" && (args.stackIn === undefined || args.zapsOut === undefined)) return [];
    return [{
      emitter: log.address,
      kind,
      executor: args.executor,
      outAsset: args.outAsset,
      amountOut: args.amountOut,
      executorFee: args.executorFee ?? 0n,
      potFee: args.potFee ?? 0n,
      stackIn: kind === "recurring-stack" ? args.stackIn ?? null : null,
      zapsOut: kind === "recurring-stack" ? args.zapsOut ?? null : null,
      seriesId: args.seriesId ?? args.nonce ?? 0n,
      run: args.run === undefined ? null : Number(args.run),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    }];
  });
}

export interface ActivityEntry {
  type: "created" | "executed" | "automated" | "recovered" | "halted";
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: number | null;
  zap: Address;
  actor: Address;
  amount: string | null;
  assetSymbol: string | null;
  /** Automated rows only: "run 3 · recurring", "price trigger". Null elsewhere. */
  detail: string | null;
}

export interface ProtocolActivityStats {
  zapsCreated: number;
  executions: number;
  /** Runs submitted by an executor against a standing authorization. */
  automatedRuns: number;
  recoveries: number;
  /** One-way policy stops proven by a canonical v1.2/v3.2 emitter. */
  policiesHalted: number;
  /** Settled output volume per asset symbol, in wei strings — one-shot and automated. */
  executedVolume: Record<string, string>;
  /** Total protocol fee paid out of automated output, per asset symbol. */
  automatedFees: Record<string, string>;
  lastActivityBlock: string | null;
}

export interface ProtocolActivity {
  stats: ProtocolActivityStats;
  activity: ActivityEntry[];
  updatedAt: string;
}

export function assetSymbolFor(asset: Address): string {
  if (isAddressEqual(asset, ROBINHOOD_ASSETS.weth)) return "aeWETH";
  if (isAddressEqual(asset, ROBINHOOD_ASSETS.zaps)) return "0xZAPS";
  if (isAddressEqual(asset, ROBINHOOD_ASSETS.usdg)) return "USDG";
  if (isAddressEqual(asset, ROBINHOOD_ASSETS.ozusdg)) return "ozUSDG";
  if (isAddressEqual(asset, ROBINHOOD_ASSETS.hookr)) return "HOOKR";
  return `${asset.slice(0, 6)}…${asset.slice(-4)}`;
}

/**
 * The real decimals for a tracked asset, so an amount is formatted at 6 (USDG),
 * 9 (ozUSDG) or 18 (aeWETH/0xZAPS) rather than a hardcoded 18. Unknown assets
 * fall back to 18. `null` for the zero address (native ETH) is handled by the
 * caller, which already special-cases ETH; ETH is 18.
 */
export function assetDecimalsFor(asset: Address): number {
  for (const token of Object.values(ROBINHOOD_TOKENS)) {
    if (isAddressEqual(asset, token.address)) return token.decimals;
  }
  return 18;
}

/** Human label for an automated row: "run 3 · recurring" / "price trigger". */
export function describeAutomatedRun(kind: AutomatedRunKind, run: number | null): string {
  if (kind === "trigger") return "price trigger";
  const label =
    kind === "recurring-stack"
      ? "recurring · stacks 0xZAPS"
      : kind === "recurring-relative"
        ? "recurring · spot floor"
        : "recurring";
  return run === null ? label : `run ${run} · ${label}`;
}

/**
 * Merge raw logs into a truthful feed. Executed/EmergencyExit logs are only
 * counted when their emitter is a zap the canonical factory created — any
 * contract can emit an identically-shaped event, and spoofed rows must never
 * reach the feed or the stats.
 */
export function aggregateActivity(
  created: readonly CreatedLogInput[],
  executed: readonly ExecutedLogInput[],
  exits: readonly ExitLogInput[],
  automated: readonly AutomatedRunLogInput[],
  timestamps: ReadonlyMap<bigint, number>,
  updatedAt: string,
  halted: readonly PolicyHaltedLogInput[] = [],
): ProtocolActivity {
  const creationByZap = new Map(created.map((log) => [getAddress(log.zap), log]));
  const canonicalZaps = new Set(creationByZap.keys());
  const verifiedExecuted = executed.filter((log) => canonicalZaps.has(getAddress(log.emitter)));
  const verifiedExits = exits.filter((log) => canonicalZaps.has(getAddress(log.emitter)));
  // Automated runs pass the same emitter check: any contract can emit an
  // identically-shaped ExecutedRecurring, so only a capsule one of the factories
  // actually created may contribute a row, a count, or volume.
  const verifiedAutomated = automated.filter((log) => canonicalZaps.has(getAddress(log.emitter)));
  const verifiedHalted = halted.filter((log) => {
    const creation = creationByZap.get(getAddress(log.emitter));
    if (!creation) return false;
    const lineage = configuredCapsuleLineageForFactory(creation.factory)?.id;
    return (
      (lineage === "v1.2" || lineage === "v3.2")
      && matchesPolicyHaltCreation(log, creation)
    );
  });

  const executedVolume: Record<string, bigint> = {};
  for (const log of verifiedExecuted) {
    const symbol = assetSymbolFor(log.outAsset);
    executedVolume[symbol] = (executedVolume[symbol] ?? 0n) + log.amountOut;
  }
  const automatedFees: Record<string, bigint> = {};
  for (const log of verifiedAutomated) {
    const symbol = assetSymbolFor(log.outAsset);
    executedVolume[symbol] = (executedVolume[symbol] ?? 0n) + log.amountOut;
    automatedFees[symbol] = (automatedFees[symbol] ?? 0n) + log.executorFee + log.potFee;
  }

  const entries: ActivityEntry[] = [
    ...created.map((log): ActivityEntry & { sortBlock: bigint; sortIndex: number } => ({
      type: "created",
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: timestamps.get(log.blockNumber) ?? null,
      zap: getAddress(log.zap),
      actor: getAddress(log.owner),
      amount: null,
      assetSymbol: null,
      detail: null,
      sortBlock: log.blockNumber,
      sortIndex: log.logIndex,
    })),
    ...verifiedExecuted.map((log): ActivityEntry & { sortBlock: bigint; sortIndex: number } => ({
      type: "executed",
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: timestamps.get(log.blockNumber) ?? null,
      zap: getAddress(log.emitter),
      actor: getAddress(log.recipient),
      amount: log.amountOut.toString(),
      assetSymbol: assetSymbolFor(log.outAsset),
      detail: null,
      sortBlock: log.blockNumber,
      sortIndex: log.logIndex,
    })),
    ...verifiedAutomated.map((log): ActivityEntry & { sortBlock: bigint; sortIndex: number } => ({
      type: "automated",
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: timestamps.get(log.blockNumber) ?? null,
      zap: getAddress(log.emitter),
      actor: getAddress(log.executor),
      amount: log.amountOut.toString(),
      assetSymbol: assetSymbolFor(log.outAsset),
      detail: describeAutomatedRun(log.kind, log.run),
      sortBlock: log.blockNumber,
      sortIndex: log.logIndex,
    })),
    ...verifiedExits.map((log): ActivityEntry & { sortBlock: bigint; sortIndex: number } => ({
      type: "recovered",
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: timestamps.get(log.blockNumber) ?? null,
      zap: getAddress(log.emitter),
      actor: getAddress(log.owner),
      amount: log.amount.toString(),
      assetSymbol: assetSymbolFor(log.asset),
      detail: null,
      sortBlock: log.blockNumber,
      sortIndex: log.logIndex,
    })),
    ...verifiedHalted.map((log): ActivityEntry & { sortBlock: bigint; sortIndex: number } => ({
      type: "halted",
      txHash: log.txHash,
      blockNumber: log.blockNumber.toString(),
      logIndex: log.logIndex,
      timestamp: timestamps.get(log.blockNumber) ?? null,
      zap: getAddress(log.emitter),
      actor: getAddress(log.owner),
      amount: null,
      assetSymbol: null,
      detail: "execution policy permanently halted",
      sortBlock: log.blockNumber,
      sortIndex: log.logIndex,
    })),
  ]
    .sort((a, b) => (a.sortBlock === b.sortBlock ? b.sortIndex - a.sortIndex : a.sortBlock < b.sortBlock ? 1 : -1))
    .map((entry) => ({
      type: entry.type,
      txHash: entry.txHash,
      blockNumber: entry.blockNumber,
      logIndex: entry.logIndex,
      timestamp: entry.timestamp,
      zap: entry.zap,
      actor: entry.actor,
      amount: entry.amount,
      assetSymbol: entry.assetSymbol,
      detail: entry.detail,
    }));

  const lastActivityBlock = entries[0]?.blockNumber ?? null;

  return {
    stats: {
      zapsCreated: created.length,
      executions: verifiedExecuted.length,
      automatedRuns: verifiedAutomated.length,
      recoveries: verifiedExits.length,
      policiesHalted: verifiedHalted.length,
      executedVolume: Object.fromEntries(
        Object.entries(executedVolume).map(([symbol, total]) => [symbol, total.toString()]),
      ),
      automatedFees: Object.fromEntries(
        Object.entries(automatedFees).map(([symbol, total]) => [symbol, total.toString()]),
      ),
      lastActivityBlock,
    },
    activity: entries.slice(0, ACTIVITY_FEED_LIMIT),
    updatedAt,
  };
}
