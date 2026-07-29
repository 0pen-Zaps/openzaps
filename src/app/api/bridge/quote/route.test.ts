import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_ROUTES, BridgeQuoteError } from "@/lib/bridge";

const serverMocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  fetchQuote: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/bridge-server", () => ({
  acrossBridgeApiEnabled: serverMocks.enabled,
  fetchAcrossBridgeQuote: serverMocks.fetchQuote,
}));

vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: serverMocks.rateLimit,
}));

import { POST } from "./route";

const ROUTE = BRIDGE_ROUTES[0];
const DEPOSITOR = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function quoteRequest(
  body: string = JSON.stringify({
    routeId: ROUTE.id,
    outputAmount: "100000000",
    depositor: DEPOSITOR,
    recipient: RECIPIENT,
  }),
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://0xzaps.com/api/bridge/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.41",
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverMocks.enabled.mockReturnValue(true);
  serverMocks.rateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
});

describe("Across quote Route Handler", () => {
  it("fails closed at the production feature gate before reading the body", async () => {
    serverMocks.enabled.mockReturnValue(false);

    const response = await POST(quoteRequest("{}"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "FEATURE_DISABLED" });
    expect(serverMocks.rateLimit).not.toHaveBeenCalled();
    expect(serverMocks.fetchQuote).not.toHaveBeenCalled();
  });

  it("maps declared-size and malformed body failures without calling Across", async () => {
    const declared = await POST(quoteRequest("{}", { "content-length": "2049" }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "Bridge quote request is too large." });

    const malformed = await POST(quoteRequest("{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Bridge quote request must be JSON." });
    expect(serverMocks.fetchQuote).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unknown route",
      { routeId: "unknown", outputAmount: "1", depositor: DEPOSITOR, recipient: RECIPIENT },
      "Unknown bridge route.",
    ],
    [
      "non-canonical amount",
      { routeId: ROUTE.id, outputAmount: 1, depositor: DEPOSITOR, recipient: RECIPIENT },
      "Output amount must be a positive integer string.",
    ],
    [
      "amount above uint256",
      {
        routeId: ROUTE.id,
        outputAmount: (1n << 256n).toString(),
        depositor: DEPOSITOR,
        recipient: RECIPIENT,
      },
      "Output amount exceeds uint256.",
    ],
    [
      "bad depositor",
      { routeId: ROUTE.id, outputAmount: "1", depositor: "0x1234", recipient: RECIPIENT },
      "Depositor must be an EVM address.",
    ],
    [
      "bad recipient",
      { routeId: ROUTE.id, outputAmount: "1", depositor: DEPOSITOR, recipient: "0x1234" },
      "Recipient must be an EVM address.",
    ],
  ])("rejects %s input at the route boundary", async (_name, body, message) => {
    const response = await POST(quoteRequest(JSON.stringify(body)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(serverMocks.fetchQuote).not.toHaveBeenCalled();
  });

  it("maps the warm-instance quota to 429 with Retry-After", async () => {
    serverMocks.rateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 37 });

    const response = await POST(quoteRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(serverMocks.fetchQuote).not.toHaveBeenCalled();
  });

  it("maps a validated provider failure to a no-store 502", async () => {
    serverMocks.fetchQuote.mockRejectedValue(
      new BridgeQuoteError("Across answered 503; no deposit transaction was accepted."),
    );

    const response = await POST(quoteRequest());

    expect(serverMocks.fetchQuote).toHaveBeenCalledWith({
      routeId: ROUTE.id,
      outputAmount: 100_000_000n,
      depositor: DEPOSITOR,
      recipient: RECIPIENT,
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.json()).toEqual({
      error: "Across answered 503; no deposit transaction was accepted.",
    });
  });
});
