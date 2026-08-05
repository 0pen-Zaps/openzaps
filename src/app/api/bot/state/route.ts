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

// Default state — in production, this would come from a file/database
const DEFAULT_STATE: BotState = {
  positions: [],
  stats: {
    totalSeen: 6306,
    totalBought: 0,
    totalSold: 0,
    realizedPnlEth: 0,
    bestTrade: "N/A",
    worstTrade: "N/A",
  },
  config: {
    maxEthPerBuy: 0.05,
    maxConcurrent: 3,
    slippageBps: 1500,
    minRealBuyers: 6,
    scoringWindowBlocks: 50,
    waitBlocksBeforeScore: 15,
    stopLossPercent: 50,
    maxHoldDays: 7,
  },
};

export function GET(): NextResponse {
  return NextResponse.json(DEFAULT_STATE, {
    headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    // MERGE new config values into default
    if (body.config) {
      Object.assign(DEFAULT_STATE.config, body.config);
    }
    return NextResponse.json({ ok: true, state: DEFAULT_STATE }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}