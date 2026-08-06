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
  /** Streak counters — reset on the opposite outcome. Position sizing reads these. */
  wins: number;
  losses: number;
  /** Cumulative counts. Only these can form a win rate. */
  winsTotal?: number;
  lossesTotal?: number;
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
        // Report cumulative wins/losses, not the streak counters. Dividing a
        // streak by the trade count renders "0%" the moment one loss lands.
        // Older state files predate these fields; omit the rate rather than
        // compute a wrong one from the streaks.
        wins: state.winsTotal ?? 0,
        losses: state.lossesTotal ?? 0,
        winRate:
          state.winsTotal === undefined || state.trades === 0
            ? null
            : Math.round((state.winsTotal / state.trades) * 100),
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