import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const serverMocks = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/virtual-trading-server", () => ({
  fetchVirtualMarketSnapshot: serverMocks.fetchSnapshot,
}));
vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: serverMocks.rateLimit,
}));

import { GET } from "./route";

const SNAPSHOT = {
  chainId: 4663,
  blockNumber: "500",
  blockHash: `0x${"11".repeat(32)}`,
  blockTimestamp: "1800000000",
  readAt: "2027-01-15T12:00:00.000Z",
  source: "canonical Robinhood Chain head eth_call",
  markets: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  serverMocks.fetchSnapshot.mockResolvedValue(SNAPSHOT);
  serverMocks.rateLimit.mockReturnValue({
    limited: false,
    retryAfterSeconds: 0,
  });
});

describe("virtual trading markets Route Handler", () => {
  it("serves canonical marks with short shared-cache headers", async () => {
    const request = new NextRequest("http://localhost/api/virtual-trading/markets");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(serverMocks.rateLimit).toHaveBeenCalledWith(
      request,
      "virtual-trading-markets",
      30,
      60_000,
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=30",
    );
    expect(await response.json()).toEqual(SNAPSHOT);
  });

  it("returns a non-cacheable 429 before requesting a mark when locally throttled", async () => {
    serverMocks.rateLimit.mockReturnValue({
      limited: true,
      retryAfterSeconds: 21,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/virtual-trading/markets"),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("retry-after")).toBe("21");
    expect(serverMocks.fetchSnapshot).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "Too many virtual market requests. Try again shortly.",
    });
  });

  it("fails closed with 503 when canonical marks cannot be verified", async () => {
    serverMocks.fetchSnapshot.mockRejectedValue(new Error("RPC unavailable"));

    const response = await GET(
      new NextRequest("http://localhost/api/virtual-trading/markets"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=5");
    expect(await response.json()).toEqual({
      error: "Canonical virtual market marks are temporarily unavailable.",
    });
  });
});
