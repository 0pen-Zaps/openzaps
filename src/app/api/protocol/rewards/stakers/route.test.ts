import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeeRewardsStakersPayload } from "@/lib/rewards-stakers";

const { fetchStakersMock, StaleStakersErrorMock } = vi.hoisted(() => ({
  fetchStakersMock: vi.fn(),
  StaleStakersErrorMock: class StaleStakersSnapshotError extends Error {},
}));

vi.mock("@/lib/rewards-stakers-server", () => ({
  fetchFeeRewardsStakers: fetchStakersMock,
  StaleStakersSnapshotError: StaleStakersErrorMock,
}));

import { GET } from "@/app/api/protocol/rewards/stakers/route";

const fixture: FeeRewardsStakersPayload = {
  headBlock: "25624465",
  blockHash: `0x${"1".repeat(64)}`,
  blockTimestamp: "1785686400",
  readAt: "2026-08-02T12:00:00.000Z",
  campaignCodeHash: "0xdc3b2cc96fedbf6c7de50f4bfd0d5ad37b3039a0a30bde0510a559aba8393312",
  totalStaked: "11",
  totalRewardWeight: "24",
  activeStakerCount: 1,
  allTimeStakerCount: 1,
  totalEarnedWeth: "3",
  totalClaimedWeth: "0",
  truncated: false,
  stakers: [
    {
      account: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      stakedBalance: "11",
      rewardWeight: "24",
      earnedWeth: "3",
      claimedWeth: "0",
    },
  ],
};

describe("GET /api/protocol/rewards/stakers", () => {
  beforeEach(() => {
    fetchStakersMock.mockReset();
    fetchStakersMock.mockResolvedValue(fixture);
  });

  it("serves the verified register without a second stale cache layer", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual(fixture);
  });

  it("fails closed instead of serving a partial or zeroed list", async () => {
    fetchStakersMock.mockRejectedValue(new Error("enumeration does not reconcile"));
    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "The verified staker list is unavailable right now.",
    });
  });

  it("returns a bounded retry signal while the verified cache refreshes", async () => {
    fetchStakersMock.mockRejectedValue(new StaleStakersErrorMock());
    const response = await GET();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      error: "The verified staker list is refreshing.",
    });
  });
});
