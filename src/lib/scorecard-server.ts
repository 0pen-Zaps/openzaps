import { Buffer } from "node:buffer";
import { getAddress, isAddress, type Address } from "viem";

import { EXECUTION_RECEIPTS_TABLE } from "@/lib/receipt-server";
import { relayHeaders, relayUrl } from "@/lib/relay-server";

export interface ScorecardReceiptEvidence {
  outcome: "reverted" | "finalized";
  zap: string;
  blockNumber: string;
  txHash: string;
  gasUsed: string;
  blockTime: string;
  eventPayload: Record<string, unknown>;
}

export interface ExecutorScorecard {
  executor: Address;
  attempts: number;
  finalized: number;
  reverted: number;
  reliabilityBps: number | null;
  uniqueZaps: number;
  totalGasUsed: string;
  firstBlock: string | null;
  lastBlock: string | null;
  lastExecutionAt: string | null;
  executorFeesByAsset: Record<string, string>;
  executorFeeAssetCount: number;
  executorFeesTruncated: boolean;
  evidence: "factory-proven-onchain-receipts";
  coverage: "reference-executor-receipts";
  authorityScope: "none";
}

export interface ExecutorScorecardPage {
  scorecard: ExecutorScorecard;
  history: ScorecardReceiptEvidence[];
  nextCursor: string | null;
}

interface ReceiptEvidenceRow {
  outcome: "reverted" | "finalized";
  zap: string;
  block_number: string | number;
  tx_hash: string;
  gas_used: string | number;
  block_time: string;
  event_payload: Record<string, unknown> | null;
}

interface ScorecardAggregateRow {
  attempts: string | number;
  finalized: string | number;
  reverted: string | number;
  reliability_bps: number | null;
  unique_zaps: string | number;
  total_gas_used: string | number;
  first_block: string | number | null;
  last_block: string | number | null;
  last_execution_at: string | null;
  executor_fees_by_asset: Record<string, string> | null;
  executor_fee_asset_count: string | number;
}

interface ScorecardCursor {
  blockNumber: string;
  txHash: string;
}

const SCORECARD_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]{1,78}$/;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;

function evidenceFromRow(row: ReceiptEvidenceRow): ScorecardReceiptEvidence {
  return {
    outcome: row.outcome,
    zap: row.zap,
    blockNumber: String(row.block_number),
    txHash: row.tx_hash,
    gasUsed: String(row.gas_used),
    blockTime: row.block_time,
    eventPayload: row.event_payload ?? {},
  };
}

export function scorecardPageLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  if (!/^[0-9]{1,2}$/.test(raw)) throw new Error(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  }
  return limit;
}

export function encodeScorecardCursor(cursor: ScorecardCursor): string {
  if (!DECIMAL.test(cursor.blockNumber) || !TX_HASH.test(cursor.txHash)) {
    throw new Error("Scorecard cursor is malformed.");
  }
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeScorecardCursor(raw: string): ScorecardCursor {
  if (!SCORECARD_CURSOR.test(raw)) throw new Error("Scorecard cursor is malformed.");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      v?: unknown;
      blockNumber?: unknown;
      txHash?: unknown;
    };
    if (
      parsed.v !== 1
      || typeof parsed.blockNumber !== "string"
      || !DECIMAL.test(parsed.blockNumber)
      || typeof parsed.txHash !== "string"
      || !TX_HASH.test(parsed.txHash)
    ) {
      throw new Error("invalid fields");
    }
    return { blockNumber: parsed.blockNumber, txHash: parsed.txHash };
  } catch {
    throw new Error("Scorecard cursor is malformed.");
  }
}

function safeCount(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Scorecard ${field} is invalid.`);
  return parsed;
}

export function scorecardFromAggregateRow(
  executor: Address,
  row: ScorecardAggregateRow,
): ExecutorScorecard {
  const attempts = safeCount(row.attempts, "attempts");
  const finalized = safeCount(row.finalized, "finalized");
  const reverted = safeCount(row.reverted, "reverted");
  const executorFeeAssetCount = safeCount(row.executor_fee_asset_count, "executor fee assets");
  const fees = Object.fromEntries(
    Object.entries(row.executor_fees_by_asset ?? {}).filter(
      ([asset, amount]) => isAddress(asset) && typeof amount === "string" && DECIMAL.test(amount),
    ),
  );
  return {
    executor: getAddress(executor),
    attempts,
    finalized,
    reverted,
    reliabilityBps: row.reliability_bps,
    uniqueZaps: safeCount(row.unique_zaps, "unique zaps"),
    totalGasUsed: String(row.total_gas_used),
    firstBlock: row.first_block === null ? null : String(row.first_block),
    lastBlock: row.last_block === null ? null : String(row.last_block),
    lastExecutionAt: row.last_execution_at,
    executorFeesByAsset: fees,
    executorFeeAssetCount,
    executorFeesTruncated: executorFeeAssetCount > Object.keys(fees).length,
    evidence: "factory-proven-onchain-receipts",
    coverage: "reference-executor-receipts",
    authorityScope: "none",
  };
}

export function buildExecutorScorecard(
  executor: Address,
  receipts: readonly ScorecardReceiptEvidence[],
): ExecutorScorecard {
  let finalized = 0;
  let reverted = 0;
  let gas = 0n;
  let firstBlock: bigint | null = null;
  let lastBlock: bigint | null = null;
  let lastExecutionAt: string | null = null;
  const zaps = new Set<string>();
  const fees = new Map<string, bigint>();

  for (const receipt of receipts) {
    if (receipt.outcome === "finalized") finalized += 1;
    else reverted += 1;
    gas += BigInt(receipt.gasUsed);
    const block = BigInt(receipt.blockNumber);
    if (firstBlock === null || block < firstBlock) firstBlock = block;
    if (lastBlock === null || block > lastBlock) {
      lastBlock = block;
      lastExecutionAt = receipt.blockTime;
    }
    zaps.add(receipt.zap.toLowerCase());

    const asset = receipt.eventPayload.outAsset;
    const fee = receipt.eventPayload.executorFee;
    if (typeof asset === "string" && isAddress(asset) && typeof fee === "string" && /^[0-9]+$/.test(fee)) {
      const key = asset.toLowerCase();
      fees.set(key, (fees.get(key) ?? 0n) + BigInt(fee));
    }
  }

  const attempts = finalized + reverted;
  return {
    executor: getAddress(executor),
    attempts,
    finalized,
    reverted,
    reliabilityBps: attempts === 0 ? null : Math.floor((finalized * 10_000) / attempts),
    uniqueZaps: zaps.size,
    totalGasUsed: gas.toString(),
    firstBlock: firstBlock?.toString() ?? null,
    lastBlock: lastBlock?.toString() ?? null,
    lastExecutionAt,
    executorFeesByAsset: Object.fromEntries([...fees.entries()].map(([asset, value]) => [asset, value.toString()])),
    executorFeeAssetCount: fees.size,
    executorFeesTruncated: false,
    evidence: "factory-proven-onchain-receipts",
    // Reverted transactions emit no event and cannot be globally discovered without a transaction
    // index. The reference executor records both outcomes; callers must not infer global coverage.
    coverage: "reference-executor-receipts",
    authorityScope: "none",
  };
}

async function executorScorecardAggregate(executor: Address): Promise<ExecutorScorecard> {
  const response = await fetch(relayUrl("rpc/executor_scorecard_aggregate"), {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({ p_executor: executor.toLowerCase() }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Scorecard aggregate query failed (${response.status}).`);
  const rows = (await response.json()) as ScorecardAggregateRow[];
  const row = rows[0];
  if (!row) throw new Error("Scorecard aggregate returned no row.");
  return scorecardFromAggregateRow(executor, row);
}

async function executorReceiptPage(
  executor: Address,
  limit: number,
  cursor: string | null,
): Promise<{ history: ScorecardReceiptEvidence[]; nextCursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  }
  const decoded = cursor ? decodeScorecardCursor(cursor) : null;
  const params = new URLSearchParams({
    select: "outcome,zap,block_number,tx_hash,gas_used,block_time,event_payload",
    executor: `eq.${executor.toLowerCase()}`,
    provenance_verified: "eq.true",
    order: "block_number.desc,tx_hash.desc",
    limit: String(limit + 1),
  });
  if (decoded) {
    params.set(
      "or",
      `(block_number.lt.${decoded.blockNumber},and(block_number.eq.${decoded.blockNumber},tx_hash.lt.${decoded.txHash}))`,
    );
  }
  const response = await fetch(relayUrl(`${EXECUTION_RECEIPTS_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Scorecard receipt query failed (${response.status}).`);
  const rows = (await response.json()) as ReceiptEvidenceRow[];
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    history: pageRows.map(evidenceFromRow),
    nextCursor:
      rows.length > limit && last
        ? encodeScorecardCursor({ blockNumber: String(last.block_number), txHash: last.tx_hash })
        : null,
  };
}

/** Lifetime totals are aggregated in Postgres; no serverless process walks the entire history. */
export async function executorScorecard(executorInput: string): Promise<ExecutorScorecard> {
  if (!isAddress(executorInput)) throw new Error("executor must be a valid address.");
  return executorScorecardAggregate(getAddress(executorInput));
}

/** Aggregate totals plus one explicit, bounded keyset page of factory-proven receipt evidence. */
export async function executorScorecardPage(
  executorInput: string,
  limit: number,
  cursor: string | null,
): Promise<ExecutorScorecardPage> {
  if (!isAddress(executorInput)) throw new Error("executor must be a valid address.");
  const executor = getAddress(executorInput);
  const [scorecard, page] = await Promise.all([
    executorScorecardAggregate(executor),
    executorReceiptPage(executor, limit, cursor),
  ]);
  return { scorecard, ...page };
}
