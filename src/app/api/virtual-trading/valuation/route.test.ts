import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  fetchValuation: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/virtual-trading-server", () => ({
  fetchVirtualPortfolioValuation: serverMocks.fetchValuation,
}));

vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: serverMocks.rateLimit,
}));

import { POST } from "./route";

const VALID_BODY = {
  zapsRaw: "123456",
  wethRaw: "789012",
  portfolioRevision: 4,
};

const VALUATION = {
  portfolioRevision: 4,
  chainId: 4663,
  blockNumber: "500",
  blockHash: `0x${"11".repeat(32)}`,
  blockTimestamp: "1800000000",
  readAt: "2027-01-15T12:00:00.000Z",
  source: "canonical Robinhood Chain head eth_call",
  positions: {
    zaps: {
      quoteKind: "standalone-full-position",
      routeId: "robinhood-v4-route-zaps-usdg",
      inputRaw: "123456",
      outputRaw: "700",
    },
    weth: {
      quoteKind: "standalone-full-position",
      routeId: "robinhood-v4-weth-usdg",
      inputRaw: "789012",
      outputRaw: "1300",
    },
  },
  portfolioRouteIds: [
    "robinhood-v4-zaps-weth",
    "robinhood-v4-weth-usdg",
  ],
  portfolioOutputRaw: "1900",
};

function valuationRequest(
  body: unknown = VALID_BODY,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://0xzaps.com/api/virtual-trading/valuation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.62",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverMocks.rateLimit.mockReturnValue({
    limited: false,
    retryAfterSeconds: 0,
  });
  serverMocks.fetchValuation.mockResolvedValue(VALUATION);
});

describe("virtual trading valuation Route Handler", () => {
  it("returns an exact no-store valuation and parses both positions to bigint", async () => {
    const response = await POST(valuationRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await response.json()).toEqual(VALUATION);
    expect(serverMocks.fetchValuation).toHaveBeenCalledWith({
      zapsRaw: 123_456n,
      wethRaw: 789_012n,
      portfolioRevision: 4,
    });
  });

  it("accepts canonical zero positions", async () => {
    const response = await POST(
      valuationRequest({
        zapsRaw: "0",
        wethRaw: "0",
        portfolioRevision: 0,
      }),
    );

    expect(response.status).toBe(200);
    expect(serverMocks.fetchValuation).toHaveBeenCalledWith({
      zapsRaw: 0n,
      wethRaw: 0n,
      portfolioRevision: 0,
    });
  });

  it("maps the warm-instance quota to 429 with Retry-After", async () => {
    serverMocks.rateLimit.mockReturnValue({
      limited: true,
      retryAfterSeconds: 23,
    });

    const response = await POST(valuationRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(serverMocks.fetchValuation).not.toHaveBeenCalled();
  });

  it("bounds and parses the JSON body before valuation", async () => {
    const oversized = await POST(
      valuationRequest("{}", { "content-length": "513" }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: "Portfolio valuation request is too large.",
    });

    const malformed = await POST(valuationRequest("{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Portfolio valuation request must be valid JSON.",
    });
    expect(serverMocks.fetchValuation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an array",
      [],
      "Portfolio valuation request must be an object.",
    ],
    [
      "an extra field",
      { ...VALID_BODY, cashRaw: "1" },
      "Portfolio valuation request has missing or unsupported fields.",
    ],
    [
      "a missing field",
      { zapsRaw: "1", portfolioRevision: 0 },
      "Portfolio valuation request has missing or unsupported fields.",
    ],
    [
      "an unsafe revision",
      { ...VALID_BODY, portfolioRevision: Number.MAX_SAFE_INTEGER + 1 },
      "Portfolio revision must be a non-negative safe integer.",
    ],
    [
      "a negative revision",
      { ...VALID_BODY, portfolioRevision: -1 },
      "Portfolio revision must be a non-negative safe integer.",
    ],
    [
      "a negative 0xZAPS position",
      { ...VALID_BODY, zapsRaw: "-1" },
      "0xZAPS position must be a canonical non-negative integer string.",
    ],
    [
      "a non-canonical 0xZAPS position",
      { ...VALID_BODY, zapsRaw: "01" },
      "0xZAPS position must be a canonical non-negative integer string.",
    ],
    [
      "a numeric aeWETH position",
      { ...VALID_BODY, wethRaw: 1 },
      "aeWETH position must be a canonical non-negative integer string.",
    ],
    [
      "a 0xZAPS uint128 overflow",
      { ...VALID_BODY, zapsRaw: (1n << 128n).toString() },
      "0xZAPS position exceeds uint128.",
    ],
    [
      "an aeWETH uint128 overflow",
      { ...VALID_BODY, wethRaw: (1n << 128n).toString() },
      "aeWETH position exceeds uint128.",
    ],
  ])("rejects %s at the public boundary", async (_name, body, error) => {
    const response = await POST(valuationRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(serverMocks.fetchValuation).not.toHaveBeenCalled();
  });

  it("returns no-store 503 when one exact canonical valuation cannot be established", async () => {
    serverMocks.fetchValuation.mockRejectedValue(new Error("moving head"));

    const response = await POST(valuationRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "An exact canonical portfolio valuation is temporarily unavailable.",
    });
  });
});
