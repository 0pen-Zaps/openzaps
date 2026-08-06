import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface BotPosition {
  token: string;
  symbol: string;
  name: string;
  ethIn: number;
  tokenOut?: number;
  entryPrice?: string;
  currentPrice?: string;
  pnlPercent?: number;
  timestamp: number;
  status: "ACTIVE" | "SOLD" | "DRY_RUN" | "PENDING";
  txHash?: string;
  sellTxHash?: string;
  score: number;
}

export interface BotState {
  positions: BotPosition[];
  stats: {
    totalSeen: number;
    totalBought: number;
    totalSold: number;
    realizedPnlEth: number;
    bestTrade: string;
    worstTrade: string;
  };
  config: {
    maxEthPerBuy: number;
    maxConcurrent: number;
    slippageBps: number;
    minRealBuyers: number;
    scoringWindowBlocks: number;
    waitBlocksBeforeScore: number;
    stopLossPercent: number;
    maxHoldDays: number;
  };
}

// Default state — in production, this would come from a file/database.
//
// `totalSeen` previously carried a hardcoded 6306, which read as a real
// scan count on a public page. There is no data source behind it, so it
// reports 0 until one exists. Frozen because this module-level object is
// shared by every request the serverless instance handles — and frozen one
// level down too, since a shallow freeze still leaves `.config`/`.stats`
// writable, which is exactly where the cross-request mutation happened.
const DEFAULT_STATE: BotState = Object.freeze({
  positions: [] as BotPosition[],
  stats: Object.freeze({
    totalSeen: 0,
    totalBought: 0,
    totalSold: 0,
    realizedPnlEth: 0,
    bestTrade: "N/A",
    worstTrade: "N/A",
  }),
  config: Object.freeze({
    maxEthPerBuy: 0.05,
    maxConcurrent: 3,
    slippageBps: 1500,
    minRealBuyers: 6,
    scoringWindowBlocks: 50,
    waitBlocksBeforeScore: 15,
    stopLossPercent: 50,
    maxHoldDays: 7,
  }),
});

export function GET(): NextResponse {
  return NextResponse.json(DEFAULT_STATE, {
    headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" },
  });
}

/**
 * Echo the caller's config merged over the defaults.
 *
 * This previously did `Object.assign(DEFAULT_STATE.config, body.config)`, which
 * mutated the module singleton — an unauthenticated request changed the config
 * every other visitor of that serverless instance then saw. The merge is now
 * per-request and the shared object is never touched. Nothing is persisted;
 * this endpoint has no store behind it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const state: BotState = {
      ...DEFAULT_STATE,
      config: { ...DEFAULT_STATE.config, ...(body?.config ?? {}) },
    };
    return NextResponse.json({ ok: true, persisted: false, state }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}