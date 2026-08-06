import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_FILE = resolve(process.cwd(), "data/zapbot-state.json");

interface BotState {
  bankroll: number;
  available: number;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  volume: number;
  status: string;
  action: string;
  actionTime: number;
  start: number;
  trade?: {
    token: string;
    sym: string;
    name: string;
    entryBlock: number;
    entryPrice: number;
    entryEth: number;
    txHash: string;
    timestamp: number;
  };
  history?: {
    sym: string;
    entry: number;
    exit: number;
    eth: number;
    exitEth: number;
    pnlPct: number;
    pnl: number;
    reason: string;
    dur: number;
    ts: number;
  }[];
}

export async function GET() {
  let state: BotState | null = null;
  let stateAge = 0;

  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf8");
      state = JSON.parse(raw);
      stateAge = Math.round((Date.now() - (state?.actionTime ?? 0)) / 1000);
    } catch {}
  }

  const strategy = {
    entry: { minScore: 3, minBuyers: 1, maxAgeBlocks: 120, maxFirstBuyerBlock: 20 },
    exit: { tp1: 15, tp1Fraction: 0.5, tp2: 35, tp2Fraction: 0.5, stopLoss: -8, deadMinutes: 2, maxHoldMinutes: 4 },
    sizing: { basePct: 20, maxPct: 35, gasReserve: 0.01, cooldownMult: 0.5, streakThreshold: 3, streakMult: 1.25 },
    edge: "Smart money enters block 2-4, exits block 9-32. Mirror this.",
  };

  const session = state
    ? {
        bankroll: state.bankroll,
        available: state.available,
        pnl: state.pnl,
        trades: state.trades,
        wins: state.wins,
        losses: state.losses,
        winRate: state.trades > 0 ? Math.round((state.wins / state.trades) * 100) : 0,
        status: state.status,
        action: state.action,
        stateAgeSeconds: stateAge,
        running: Date.now() - (state.start ?? 0) > 30000,
        currentTrade: state.trade || null,
        history: (state.history ?? []).slice(-20).reverse(),
      }
    : null;

  return NextResponse.json({ strategy, session });
}