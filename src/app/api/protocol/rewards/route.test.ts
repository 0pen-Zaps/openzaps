import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeeRewardsPayload } from "@/lib/rewards";

const { fetchFeeRewardsMock, rateLimitMock } = vi.hoisted(() => ({
  fetchFeeRewardsMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/rewards-server", () => ({
  fetchFeeRewards: fetchFeeRewardsMock,
}));

vi.mock("@/lib/relay-rate-limit", () => ({
  serverRateLimit: rateLimitMock,
}));

import { GET } from "@/app/api/protocol/rewards/route";

const fixture: FeeRewardsPayload = {
  headBlock: "25620975",
  blockHash: `0x${"1".repeat(64)}`,
  blockTimestamp: "1785686400",
  readAt: "2026-08-02T12:00:00.000Z",
  phase: "upcoming",
  verification: {
    adapterCodeHash: "0xbfb40896738d786e657e3f524595ee43d98a7570f9ec162a1262b012a868d195",
    vaultCodeHash: "0x4d62bd109d8fed9a04c02343cf6357dbf6d6789ef5ed9940b11add836c3caac4",
    campaignCodeHash: "0xdc3b2cc96fedbf6c7de50f4bfd0d5ad37b3039a0a30bde0510a559aba8393312",
    vaultActivated: true,
    sourcePositionConfigured: true,
  },
  campaign: {
    feeSharesFunded: true,
    finalized: false,
    rewardsSwept: false,
    feeSharePrincipal: "50000000000000000000",
    totalStaked: "0",
    totalRewardWeight: "0",
    rewardRate: "0",
    rewardPerTokenStored: "0",
    accountedRewardBalance: "0",
    queuedRewards: "0",
    lastUpdateAt: "1785716580",
  },
  vault: {
    totalSupply: "100000000000000000000",
    sponsorFeeShareBalance: "50000000000000000000",
    sponsorClaimableWeth: "0",
    accountedRewardBalance: "0",
    queuedRewards: "0",
  },
  viewer: null,
  permit: { name: "OpenZaps", version: "1" },
};

describe("GET /api/protocol/rewards", () => {
  beforeEach(() => {
    fetchFeeRewardsMock.mockReset();
    fetchFeeRewardsMock.mockResolvedValue(fixture);
    rateLimitMock.mockReset();
    rateLimitMock.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  });

  it("serves an anonymous snapshot without a second stale cache layer", async () => {
    const response = await GET(new Request("https://www.0xzaps.com/api/protocol/rewards"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(fetchFeeRewardsMock).toHaveBeenCalledWith(null);
    expect(rateLimitMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(fixture);
  });

  it("normalizes a viewer and prevents shared caching", async () => {
    const viewer = "0x5a52d4b820ae7f02880d270562950918acb14aa2";
    const response = await GET(
      new Request(`https://www.0xzaps.com/api/protocol/rewards?viewer=${viewer}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchFeeRewardsMock).toHaveBeenCalledWith(
      "0x5a52D4B820Ae7F02880d270562950918ACb14aA2",
    );
    expect(rateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "fee-rewards-viewer",
      30,
      60_000,
    );
  });

  it("rate limits private wallet reads before touching the RPC", async () => {
    rateLimitMock.mockReturnValue({ limited: true, retryAfterSeconds: 19 });
    const response = await GET(
      new Request(
        "https://www.0xzaps.com/api/protocol/rewards?viewer=0x5a52d4b820ae7f02880d270562950918acb14aa2",
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("19");
    expect(fetchFeeRewardsMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Too many wallet reward reads. Try again shortly.",
    });
  });

  it("rejects malformed viewers without falling back to anonymous data", async () => {
    const response = await GET(
      new Request("https://www.0xzaps.com/api/protocol/rewards?viewer=not-an-address"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchFeeRewardsMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "viewer must be a valid EVM address.",
    });
  });

  it("fails closed when the canonical snapshot cannot be verified", async () => {
    fetchFeeRewardsMock.mockRejectedValue(new Error("runtime hash mismatch"));
    const response = await GET(new Request("https://www.0xzaps.com/api/protocol/rewards"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "Verified Robinhood fee-reward reads are unavailable right now.",
    });
  });
});
