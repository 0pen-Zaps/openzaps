import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs bot script, no type declarations
import { CONFIG, closeLeg, decideExit, defaultState } from "../../scripts/zapbot-autonomous.mjs";

/**
 * The staged-exit ladder handles money, and its failure mode is silent: a
 * fraction booked twice, or a partial that never closes, just shows up as a
 * slightly wrong bankroll. These pin the accounting.
 *
 * The previous engine had `tp1Fraction`/`tp2Fraction` in config and on the
 * public page but never read them — every exit sold 100%.
 */

function openTrade(entryEth = 0.2) {
  return {
    sym: "TEST", token: "0x" + "1".repeat(40),
    entryEth, entryTick: 198000, entryPrice: 1e-9,
    remainingFraction: 1, realizedEth: 0, tp1Done: false,
  };
}

describe("decideExit ladder", () => {
  const base = { elapsed: 0.5, pnlPct: 0, remainingFraction: 1, tp1Done: false };

  it("sells only tp1Fraction at TP1 and leaves the rest open", () => {
    const { fraction, reason } = decideExit({ ...base, pnlPct: CONFIG.tp1Pct });
    expect(fraction).toBe(CONFIG.tp1Fraction);
    expect(reason).toMatch(/^tp1_/);
  });

  it("does not re-trigger TP1 once taken", () => {
    const { reason } = decideExit({ ...base, pnlPct: CONFIG.tp1Pct, tp1Done: true, remainingFraction: 0.5 });
    expect(reason).toBeNull();
  });

  it("closes the whole remainder at TP2", () => {
    const { fraction, reason } = decideExit({ ...base, pnlPct: CONFIG.tp2Pct, tp1Done: true, remainingFraction: 0.5 });
    expect(fraction).toBe(0.5);
    expect(reason).toMatch(/^tp2_/);
  });

  it("puts risk rules ahead of the profit ladder", () => {
    // Past max hold AND in TP1 territory: must close everything, not half.
    const { fraction, reason } = decideExit({ ...base, elapsed: CONFIG.maxHoldMinutes, pnlPct: CONFIG.tp1Pct });
    expect(fraction).toBe(1);
    expect(reason).toMatch(/^max_hold_/);
  });

  it("stops out on the full remainder", () => {
    const { fraction, reason } = decideExit({ ...base, pnlPct: CONFIG.stopLossPct - 1, tp1Done: true, remainingFraction: 0.5 });
    expect(fraction).toBe(0.5);
    expect(reason).toMatch(/^stop_/);
  });

  it("holds while inside every threshold", () => {
    expect(decideExit({ ...base, pnlPct: 5 }).reason).toBeNull();
  });
});

describe("closeLeg accounting", () => {
  it("keeps the position open after a partial and closes it on the second leg", () => {
    const state = { ...defaultState(), bankroll: 1, available: 0.8 };
    const t = openTrade(0.2);

    // TP1: +20% on half the position.
    const leg1 = 0.2 * 0.5 * 1.2;
    expect(closeLeg(state, t, 0.5, 20, "tp1_20.0%", leg1, 1)).toBe(false);
    expect(t.remainingFraction).toBeCloseTo(0.5);
    expect(t.tp1Done).toBe(true);
    expect(state.trades).toBe(0);

    // TP2: +40% on the remaining half.
    const leg2 = 0.2 * 0.5 * 1.4;
    expect(closeLeg(state, t, 0.5, 40, "tp2_40.0%", leg2, 2)).toBe(true);

    expect(state.trades).toBe(1);
    expect(state.winsTotal).toBe(1);
    expect(state.lossesTotal).toBe(0);
    // One position, one aggregate PnL — not two separate trades.
    expect(state.pnl).toBeCloseTo(leg1 + leg2 - 0.2, 12);
    expect(state.available).toBeCloseTo(0.8 + leg1 + leg2, 12);
    expect(state.volume).toBeCloseTo(0.2, 12);
  });

  it("books a winning TP1 followed by a stop-out as a single losing trade", () => {
    const state = { ...defaultState(), bankroll: 1, available: 0.8 };
    const t = openTrade(0.2);

    closeLeg(state, t, 0.5, 20, "tp1_20.0%", 0.2 * 0.5 * 1.2, 1);
    closeLeg(state, t, 0.5, -60, "stop_-60.0%", 0.2 * 0.5 * 0.4, 2);

    expect(state.trades).toBe(1);
    expect(state.lossesTotal).toBe(1);
    expect(state.winsTotal).toBe(0);
    expect(state.pnl).toBeLessThan(0);
    // Loss streak drives position sizing down on the next entry.
    expect(state.losses).toBe(1);
    expect(state.wins).toBe(0);
  });

  it("counts each position once so win rate stays a rate", () => {
    const state = { ...defaultState(), bankroll: 1, available: 1 };
    for (let i = 0; i < 3; i++) {
      const t = openTrade(0.1);
      closeLeg(state, t, 1, i === 2 ? -10 : 10, "x", 0.1 * (i === 2 ? 0.9 : 1.1), 1);
    }
    expect(state.trades).toBe(3);
    expect(state.winsTotal).toBe(2);
    expect(state.lossesTotal).toBe(1);
    expect(Math.round((state.winsTotal / state.trades) * 100)).toBe(67);
  });
});
