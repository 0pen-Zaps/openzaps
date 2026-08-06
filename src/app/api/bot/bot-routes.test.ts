import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for two defects that both surfaced as believable-looking
 * numbers on the public /bot page rather than as errors.
 *
 * 1. /api/bot/status divided a STREAK counter by the trade count and called it
 *    a win rate. `wins` resets to 0 on any loss, so a session with nine wins
 *    and one loss rendered "0%".
 * 2. /api/bot/state mutated a module-level object from an unauthenticated POST,
 *    so one caller's config became every other visitor's config for the life of
 *    the serverless instance.
 */

const state = vi.hoisted(() => ({ raw: null as string | null }));

vi.mock("fs", () => ({
  existsSync: () => state.raw !== null,
  readFileSync: () => {
    if (state.raw === null) throw new Error("no state file");
    return state.raw;
  },
}));

function writeState(s: Record<string, unknown>) {
  state.raw = JSON.stringify(s);
}

const BASE = {
  bankroll: 1, available: 1, pnl: 0, volume: 0,
  status: "IDLE", action: "init", actionTime: Date.now(), start: Date.now(),
  history: [],
};

beforeEach(() => {
  vi.resetModules();
  state.raw = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/bot/status win rate", () => {
  it("reports the cumulative rate, not the current streak", async () => {
    // Nine wins then one loss: the streak counter is 0, the truth is 90%.
    writeState({ ...BASE, trades: 10, wins: 0, losses: 1, winsTotal: 9, lossesTotal: 1 });
    const { GET } = await import("./status/route");
    const body = await (await GET()).json();

    expect(body.session.winRate).toBe(90);
    expect(body.session.wins).toBe(9);
    expect(body.session.losses).toBe(1);
  });

  it("returns null rather than a streak-derived rate for legacy state", async () => {
    // No winsTotal — a pre-fix state file. Showing 0% would be a lie.
    writeState({ ...BASE, trades: 10, wins: 0, losses: 1 });
    const { GET } = await import("./status/route");
    const body = await (await GET()).json();

    expect(body.session.winRate).toBeNull();
  });

  it("returns a null session when no state file exists", async () => {
    const { GET } = await import("./status/route");
    const body = await (await GET()).json();

    expect(body.session).toBeNull();
    expect(body.strategy).toBeTruthy();
  });
});

describe("/api/bot/state config isolation", () => {
  it("does not let one POST change what the next GET serves", async () => {
    const mod = await import("./state/route");

    const before = await (await mod.GET()).json();
    expect(before.config.maxEthPerBuy).toBe(0.05);

    const posted = await (
      await mod.POST(
        new Request("http://localhost/api/bot/state", {
          method: "POST",
          body: JSON.stringify({ config: { maxEthPerBuy: 999 } }),
        }),
      )
    ).json();
    expect(posted.state.config.maxEthPerBuy).toBe(999);
    expect(posted.persisted).toBe(false);

    const after = await (await mod.GET()).json();
    expect(after.config.maxEthPerBuy).toBe(0.05);
  });

  it("does not publish a fabricated scan count", async () => {
    const { GET } = await import("./state/route");
    const body = await (await GET()).json();

    expect(body.stats.totalSeen).toBe(0);
  });
});
