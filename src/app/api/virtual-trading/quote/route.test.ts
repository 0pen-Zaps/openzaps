import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  fetchFill: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/virtual-trading-server", () => ({
  fetchVirtualFill: serverMocks.fetchFill,
}));

vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: serverMocks.rateLimit,
}));

import { POST } from "./route";

const VALID_BODY = {
  marketId: "zaps",
  side: "buy",
  inputRaw: "50000000",
  clientOrderId: "order-12345678",
  portfolioRevision: 3,
};

const FILL = {
  ...VALID_BODY,
  routeId: "robinhood-v4-route-usdg-zaps",
  outputRaw: "123456789",
  gasEstimate: "88000",
  chainId: 4663,
  blockNumber: "500",
  blockHash: `0x${"11".repeat(32)}`,
  blockTimestamp: "1800000000",
  quotedAt: "2027-01-15T12:00:00.000Z",
  expiresAt: "2027-01-15T12:00:45.000Z",
};

function quoteRequest(
  body: unknown = VALID_BODY,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://0xzaps.com/api/virtual-trading/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.61",
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
  serverMocks.fetchFill.mockResolvedValue(FILL);
});

describe("virtual trading quote Route Handler", () => {
  it("returns a no-store VirtualFill and parses the input amount to bigint", async () => {
    const response = await POST(quoteRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await response.json()).toEqual(FILL);
    expect(serverMocks.fetchFill).toHaveBeenCalledWith({
      marketId: "zaps",
      side: "buy",
      inputRaw: 50_000_000n,
      clientOrderId: "order-12345678",
      portfolioRevision: 3,
    });
  });

  it("maps the warm-instance quota to 429 with Retry-After", async () => {
    serverMocks.rateLimit.mockReturnValue({
      limited: true,
      retryAfterSeconds: 19,
    });

    const response = await POST(quoteRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(serverMocks.fetchFill).not.toHaveBeenCalled();
  });

  it("bounds and parses the JSON body before quoting", async () => {
    const oversized = await POST(
      quoteRequest("{}", { "content-length": "1025" }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: "Virtual quote request is too large.",
    });

    const malformed = await POST(quoteRequest("{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Virtual quote request must be valid JSON.",
    });
    expect(serverMocks.fetchFill).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an array",
      [],
      "Virtual quote request must be an object.",
    ],
    [
      "an extra field",
      { ...VALID_BODY, wallet: "0x1234" },
      "Virtual quote request has missing or unsupported fields.",
    ],
    [
      "a missing field",
      {
        marketId: "zaps",
        side: "buy",
        inputRaw: "1",
        clientOrderId: "order-12345678",
      },
      "Virtual quote request has missing or unsupported fields.",
    ],
    [
      "an unknown market",
      { ...VALID_BODY, marketId: "btc" },
      "Unknown virtual market.",
    ],
    [
      "an invalid side",
      { ...VALID_BODY, side: "short" },
      "Virtual order side must be buy or sell.",
    ],
    [
      "a non-canonical amount",
      { ...VALID_BODY, inputRaw: "01" },
      "Virtual quote input must be a positive canonical integer string.",
    ],
    [
      "zero input",
      { ...VALID_BODY, inputRaw: "0" },
      "Virtual quote input must be a positive canonical integer string.",
    ],
    [
      "uint128 overflow",
      { ...VALID_BODY, inputRaw: (1n << 128n).toString() },
      "Virtual quote input exceeds uint128.",
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
      "an unsafe order ID",
      { ...VALID_BODY, clientOrderId: "order/123" },
      "Client order ID must be 8-80 letters, numbers, or hyphens.",
    ],
  ])("rejects %s at the public boundary", async (_name, body, error) => {
    const response = await POST(quoteRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(serverMocks.fetchFill).not.toHaveBeenCalled();
  });

  it.each(["buy", "sell"] as const)("allows a uint128-bounded %s input", async (side) => {
    const body = {
      ...VALID_BODY,
      marketId: "weth",
      side,
      inputRaw: ((1n << 128n) - 1n).toString(),
    };

    const response = await POST(quoteRequest(body));

    expect(response.status).toBe(200);
    expect(serverMocks.fetchFill.mock.calls[0]?.[0]).toMatchObject({
      marketId: "weth",
      side,
      inputRaw: (1n << 128n) - 1n,
    });
  });

  it("returns no-store 503 when a canonical quote cannot be established", async () => {
    serverMocks.fetchFill.mockRejectedValue(new Error("block hash mismatch"));

    const response = await POST(quoteRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "A canonical virtual quote is temporarily unavailable.",
    });
  });
});
