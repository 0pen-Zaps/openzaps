import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPulse: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/rewards2-server", () => ({
  fetchCampaign2StakingPulse: mocks.fetchPulse,
}));

vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: mocks.rateLimit,
}));

import { GET } from "./route";

const PULSE = {
  blockNumber: "41894119",
  blockHash: `0x${"11".repeat(32)}`,
  blockTimestamp: "1787276400",
  readAt: "2026-08-21T01:40:00.000Z",
  campaign: {
    address: "0x7F57F7B760614e67D3B3887433fA124B4c9A09F9",
    feeSharesFunded: true,
    finalized: false,
    totalStaked: "9598677870290857176582160373",
    startAt: "1787259600",
    endAt: "1788469200",
    claimDeadline: "1791061200",
  },
};

function request(): Request {
  return new Request("https://0xzaps.com/api/protocol/rewards2/staking", {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  mocks.fetchPulse.mockResolvedValue(PULSE);
});

describe("campaign-2 staking pulse route", () => {
  it("returns a verified no-store pulse", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(PULSE);
  });

  it("surfaces the warm-instance quota with Retry-After", async () => {
    mocks.rateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 37 });
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(mocks.fetchPulse).not.toHaveBeenCalled();
  });

  it("fails closed when the verified chain read is unavailable", async () => {
    mocks.fetchPulse.mockRejectedValue(new Error("RPC unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "The campaign-2 staking snapshot is unavailable right now.",
    });
  });
});
