import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import { ROBINHOOD_ASSETS, ROBINHOOD_TOKENS } from "@/lib/robinhood";

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

export interface CreatedLogInput {
  zap: Address;
  owner: Address;
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

export interface ActivityEntry {
  type: "created" | "executed" | "recovered";
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: number | null;
  zap: Address;
  actor: Address;
  amount: string | null;
  assetSymbol: string | null;
}

export interface ProtocolActivityStats {
  zapsCreated: number;
  executions: number;
  recoveries: number;
  /** Executed output volume per asset symbol, in wei strings. */
  executedVolume: Record<string, string>;
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
  timestamps: ReadonlyMap<bigint, number>,
  updatedAt: string,
): ProtocolActivity {
  const canonicalZaps = new Set(created.map((log) => getAddress(log.zap)));
  const verifiedExecuted = executed.filter((log) => canonicalZaps.has(getAddress(log.emitter)));
  const verifiedExits = exits.filter((log) => canonicalZaps.has(getAddress(log.emitter)));

  const executedVolume: Record<string, bigint> = {};
  for (const log of verifiedExecuted) {
    const symbol = assetSymbolFor(log.outAsset);
    executedVolume[symbol] = (executedVolume[symbol] ?? 0n) + log.amountOut;
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
    }));

  const lastActivityBlock = entries[0]?.blockNumber ?? null;

  return {
    stats: {
      zapsCreated: created.length,
      executions: verifiedExecuted.length,
      recoveries: verifiedExits.length,
      executedVolume: Object.fromEntries(
        Object.entries(executedVolume).map(([symbol, total]) => [symbol, total.toString()]),
      ),
      lastActivityBlock,
    },
    activity: entries.slice(0, ACTIVITY_FEED_LIMIT),
    updatedAt,
  };
}
