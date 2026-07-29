import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import {
  assetSymbolFor,
  describeAutomatedRun,
  type AutomatedRunKind,
  type AutomatedRunLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
  type PolicyHaltedLogInput,
} from "@/lib/activity";
import {
  isHaltCapableLineage,
  matchesPolicyHaltCreation,
  policyHaltStatus,
  type PolicyHaltStatus,
} from "@/lib/policy-halt";
import { configuredCapsuleLineages } from "@/lib/robinhood";

export const nonceInvalidatedEvent = {
  type: "event",
  name: "NonceInvalidated",
  inputs: [{ name: "nonce", type: "uint256", indexed: true }],
} as const;

export const seriesFinishedEvent = {
  type: "event",
  name: "SeriesFinished",
  inputs: [
    { name: "seriesId", type: "uint256", indexed: true },
    { name: "runs", type: "uint32", indexed: false },
  ],
} as const;

export type ZapLineage = "v1.1" | "v1.2" | "v3" | "v3.1" | "v3.2" | "unknown";

export function isStandingIntentLineage(
  lineage: ZapLineage,
): lineage is "v3" | "v3.1" | "v3.2" {
  return lineage === "v3" || lineage === "v3.1" || lineage === "v3.2";
}
export type WalletActivityKind =
  | "created"
  | "executed"
  | "automated"
  | "recovered"
  | "halted"
  | "revoked"
  | "series-finished";

export interface WalletCreationLogInput {
  zap: Address;
  owner: Address;
  factory: Address;
  policyHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface NonceInvalidatedLogInput {
  emitter: Address;
  nonce: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface SeriesFinishedLogInput {
  emitter: Address;
  seriesId: bigint;
  runs: number;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface WalletZapRead {
  zap: Address;
  trackedAssets: readonly Address[] | null;
  /** null for unsupported lineages and for a failed authoritative read. */
  policyHalted: boolean | null;
}

export interface WalletActivityEntry {
  id: string;
  kind: WalletActivityKind;
  status: "confirmed";
  zap: Address;
  lineage: ZapLineage;
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: number | null;
  actor: Address | null;
  amount: string | null;
  assetSymbol: string | null;
  detail: string;
  authorizationId: string | null;
  run: number | null;
  automationKind: AutomatedRunKind | null;
}

export interface WalletZapSummary {
  address: Address;
  owner: Address;
  factory: Address;
  lineage: ZapLineage;
  policyHash: Hex;
  createdAt: number | null;
  createdBlock: string;
  createdTx: Hex;
  trackedAssets: Address[] | null;
  managementReadsStatus: "live" | "unavailable";
  policyHaltStatus: PolicyHaltStatus;
  policyHalted: boolean | null;
  haltedAt: number | null;
  haltedTx: Hex | null;
  executionCount: number;
  automatedRunCount: number;
  recoveryCount: number;
  revocationCount: number;
  lastActivityAt: number | null;
  lastActivityBlock: string;
}

export interface WalletProfileStats {
  zapsCreated: number;
  oneShotExecutions: number;
  automatedRuns: number;
  recoveries: number;
  authorizationsRevoked: number;
  policiesHalted: number;
  executedVolume: Record<string, string>;
}

export interface WalletProfilePayload {
  owner: Address;
  chainId: 4663;
  sourceStatus: "live" | "degraded";
  sourceLabel: "Robinhood Chain RPC logs";
  sourceCaveat: string;
  fromBlock: string;
  headBlock: string;
  updatedAt: string;
  stats: WalletProfileStats;
  zaps: WalletZapSummary[];
  activity: WalletActivityEntry[];
}

export interface AggregateWalletProfileInput {
  owner: Address;
  created: readonly WalletCreationLogInput[];
  executed: readonly ExecutedLogInput[];
  automated: readonly AutomatedRunLogInput[];
  exits: readonly ExitLogInput[];
  invalidated: readonly NonceInvalidatedLogInput[];
  finished: readonly SeriesFinishedLogInput[];
  halted: readonly PolicyHaltedLogInput[];
  zapReads: readonly WalletZapRead[];
  timestamps: ReadonlyMap<bigint, number>;
  fromBlock: bigint;
  headBlock: bigint;
  updatedAt: string;
}

/**
 * Normalize one wallet's canonical history. The creation set is the provenance
 * gate: lookalike events from any address no OpenZap factory created for this
 * owner are discarded before they can affect rows or totals.
 */
export function aggregateWalletProfile(input: AggregateWalletProfileInput): WalletProfilePayload {
  const owner = getAddress(input.owner);
  const created = dedupeCreations(
    input.created.filter((log) => isAddressEqual(log.owner, owner)),
  );
  const creationByZap = new Map(created.map((log) => [getAddress(log.zap), log]));
  const canonical = new Set(creationByZap.keys());
  const belongs = (emitter: Address): boolean => canonical.has(getAddress(emitter));

  const executed = input.executed.filter((log) => belongs(log.emitter));
  const automated = input.automated.filter((log) => belongs(log.emitter));
  const exits = input.exits.filter((log) => belongs(log.emitter));
  const invalidated = input.invalidated.filter((log) => belongs(log.emitter));
  const finished = input.finished.filter((log) => belongs(log.emitter));
  const halted = input.halted.filter((log) => {
    const creation = creationByZap.get(getAddress(log.emitter));
    if (!creation) return false;
    const creationLineage = lineageForFactory(creation.factory);
    return isHaltCapableLineage(creationLineage)
      && matchesPolicyHaltCreation(log, creation);
  });

  const executedVolume = new Map<string, bigint>();
  for (const log of [...executed, ...automated]) {
    const symbol = assetSymbolFor(log.outAsset);
    executedVolume.set(symbol, (executedVolume.get(symbol) ?? 0n) + log.amountOut);
  }

  const lineage = (zap: Address): ZapLineage => lineageForFactory(creationByZap.get(getAddress(zap))?.factory);
  const activity: WalletActivityEntry[] = [
    ...created.map((log): SortableEntry => entry({
      kind: "created",
      zap: log.zap,
      lineage: lineage(log.zap),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: owner,
      amount: null,
      assetSymbol: null,
      detail: `${lineage(log.zap)} capsule created`,
      authorizationId: null,
      run: null,
      automationKind: null,
    })),
    ...executed.map((log): SortableEntry => entry({
      kind: "executed",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: log.recipient,
      amount: log.amountOut.toString(),
      assetSymbol: assetSymbolFor(log.outAsset),
      detail: "one-time execution confirmed",
      authorizationId: null,
      run: null,
      automationKind: null,
    })),
    ...automated.map((log): SortableEntry => entry({
      kind: "automated",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: log.executor,
      amount: log.amountOut.toString(),
      assetSymbol: assetSymbolFor(log.outAsset),
      detail: describeAutomatedRun(log.kind, log.run),
      authorizationId: log.seriesId.toString(),
      run: log.run,
      automationKind: log.kind,
    })),
    ...exits.map((log): SortableEntry => entry({
      kind: "recovered",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: log.owner,
      amount: log.amount.toString(),
      assetSymbol: assetSymbolFor(log.asset),
      detail: "tracked asset recovered to owner",
      authorizationId: null,
      run: null,
      automationKind: null,
    })),
    ...halted.map((log): SortableEntry => entry({
      kind: "halted",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: log.owner,
      amount: null,
      assetSymbol: null,
      detail: "execution policy permanently halted",
      authorizationId: null,
      run: null,
      automationKind: null,
    })),
    ...invalidated.map((log): SortableEntry => entry({
      kind: "revoked",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: owner,
      amount: null,
      assetSymbol: null,
      detail: "authorization revoked onchain",
      authorizationId: log.nonce.toString(),
      run: null,
      automationKind: null,
    })),
    ...finished.map((log): SortableEntry => entry({
      kind: "series-finished",
      zap: log.emitter,
      lineage: lineage(log.emitter),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: input.timestamps.get(log.blockNumber) ?? null,
      actor: null,
      amount: null,
      assetSymbol: null,
      detail: `series finished after ${log.runs} ${log.runs === 1 ? "run" : "runs"}`,
      authorizationId: log.seriesId.toString(),
      run: log.runs,
      automationKind: "recurring",
    })),
  ]
    .sort(newestFirst)
    .map(stripSortFields);

  const zapReadMap = new Map(input.zapReads.map((read) => [getAddress(read.zap), read]));
  const zaps = created
    .map((log): WalletZapSummary => {
      const address = getAddress(log.zap);
      const rows = activity.filter((row) => isAddressEqual(row.zap, address));
      const read = zapReadMap.get(address);
      const tracked = read?.trackedAssets;
      const zapLineage = lineage(address);
      let haltStatus = policyHaltStatus(zapLineage, read?.policyHalted ?? null);
      let projectedHalted = read?.policyHalted ?? null;
      const haltRows = rows.filter((row) => row.kind === "halted");
      if (
        (haltStatus === "active" && haltRows.length !== 0)
        || (haltStatus === "halted" && haltRows.length !== 1)
      ) {
        haltStatus = "unavailable";
        projectedHalted = null;
      }
      return {
        address,
        owner,
        factory: getAddress(log.factory),
        lineage: zapLineage,
        policyHash: log.policyHash,
        createdAt: input.timestamps.get(log.blockNumber) ?? null,
        createdBlock: log.blockNumber.toString(),
        createdTx: log.txHash,
        trackedAssets: tracked ? tracked.map(getAddress) : null,
        managementReadsStatus:
          tracked && haltStatus !== "unavailable" ? "live" : "unavailable",
        policyHaltStatus: haltStatus,
        policyHalted: projectedHalted,
        haltedAt: haltRows[0]?.timestamp ?? null,
        haltedTx: haltRows[0]?.txHash ?? null,
        executionCount: rows.filter((row) => row.kind === "executed").length,
        automatedRunCount: rows.filter((row) => row.kind === "automated").length,
        recoveryCount: rows.filter((row) => row.kind === "recovered").length,
        revocationCount: rows.filter((row) => row.kind === "revoked").length,
        lastActivityAt: rows[0]?.timestamp ?? input.timestamps.get(log.blockNumber) ?? null,
        lastActivityBlock: rows[0]?.blockNumber ?? log.blockNumber.toString(),
      };
    })
    .sort((a, b) => BigInt(a.createdBlock) < BigInt(b.createdBlock) ? 1 : -1);

  const degraded = zaps.some((zap) => zap.managementReadsStatus === "unavailable");
  return {
    owner,
    chainId: 4663,
    sourceStatus: degraded ? "degraded" : "live",
    sourceLabel: "Robinhood Chain RPC logs",
    sourceCaveat:
      "Confirmed factory and capsule events only. Reverted attempts emit no logs and cannot be reconstructed retrospectively from this RPC history; in-flight actions submitted from this profile are shown locally while the page is open.",
    fromBlock: input.fromBlock.toString(),
    headBlock: input.headBlock.toString(),
    updatedAt: input.updatedAt,
    stats: {
      zapsCreated: created.length,
      oneShotExecutions: executed.length,
      automatedRuns: automated.length,
      recoveries: exits.length,
      authorizationsRevoked: invalidated.length,
      policiesHalted: halted.length,
      executedVolume: Object.fromEntries([...executedVolume].map(([symbol, amount]) => [symbol, amount.toString()])),
    },
    zaps,
    activity,
  };
}

export function lineageForFactory(factory: Address | undefined): ZapLineage {
  if (!factory) return "unknown";
  return configuredCapsuleLineages().find((lineage) =>
    isAddressEqual(factory, lineage.factory)
  )?.id ?? "unknown";
}

type SortableEntry = WalletActivityEntry & { sortBlock: bigint; sortIndex: number };
type EntryInput = Omit<WalletActivityEntry, "id" | "status" | "blockNumber"> & { blockNumber: bigint };

function entry(input: EntryInput): SortableEntry {
  return {
    ...input,
    id: `${input.txHash}:${input.logIndex}`,
    status: "confirmed",
    blockNumber: input.blockNumber.toString(),
    zap: getAddress(input.zap),
    actor: input.actor ? getAddress(input.actor) : null,
    sortBlock: input.blockNumber,
    sortIndex: input.logIndex,
  };
}

function newestFirst(a: SortableEntry, b: SortableEntry): number {
  return a.sortBlock === b.sortBlock ? b.sortIndex - a.sortIndex : a.sortBlock < b.sortBlock ? 1 : -1;
}

function stripSortFields(row: SortableEntry): WalletActivityEntry {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    zap: row.zap,
    lineage: row.lineage,
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
    timestamp: row.timestamp,
    actor: row.actor,
    amount: row.amount,
    assetSymbol: row.assetSymbol,
    detail: row.detail,
    authorizationId: row.authorizationId,
    run: row.run,
    automationKind: row.automationKind,
  };
}

function dedupeCreations(created: readonly WalletCreationLogInput[]): WalletCreationLogInput[] {
  const byZap = new Map<string, WalletCreationLogInput>();
  for (const log of created) {
    const key = getAddress(log.zap);
    const current = byZap.get(key);
    if (!current || log.blockNumber < current.blockNumber) byZap.set(key, log);
  }
  return [...byZap.values()];
}
