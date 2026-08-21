import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPulse: vi.fn(),
}));

vi.mock("@/lib/market-server", () => ({
  fetchTokenMarketPulse: mocks.fetchPulse,
}));

import { GET } from "./route";

const PULSE = {
  pair: `0x${"11".repeat(32)}`,
  source: "DEX Screener",
  sourceUrl: `https://dexscreener.com/robinhood/0x${"11".repeat(32)}`,
  window: "rolling-24h",
  h24VolumeUsd: 64_863.28,
  h24Buys: 149,
  h24Sells: 359,
  liquidityUsd: 105_505.96,
  priceUsd: "0.000001793",
  readAt: "2026-08-21T04:09:29.494Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPulse.mockResolvedValue(PULSE);
});

describe("canonical market pulse route", () => {
  it("returns the cached, source-labelled market pulse", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=30");
    expect(await response.json()).toEqual(PULSE);
  });

  it("fails closed quickly and tells clients when to retry", async () => {
    mocks.fetchPulse.mockRejectedValue(new Error("DEX Screener unavailable"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(response.headers.get("cache-control")).toContain("s-maxage=10");
    expect(await response.json()).toEqual({
      error: "The canonical 0xZAPS market pulse is unavailable right now.",
    });
  });
});
