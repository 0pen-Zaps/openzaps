import { describe, expect, it } from "vitest";

import {
  FEE_REWARDS_MANIFEST,
  campaignCountdown,
  campaignPhase,
  feeRewardsCampaignAbi,
  feeRewardsVaultAbi,
  formatCampaignPhase,
  formatCountdown,
  permitTokenAbi,
  projectedPrincipalShare,
} from "@/lib/rewards";

function functionNames(abi: readonly { type: string; name?: string }[]): string[] {
  return abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name));
}

describe("fee rewards release manifest", () => {
  it("pins the reviewed 50-share, seven-day Robinhood campaign", () => {
    expect(FEE_REWARDS_MANIFEST.chainId).toBe(4663);
    expect(FEE_REWARDS_MANIFEST.token).toBe("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07");
    expect(FEE_REWARDS_MANIFEST.weth).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    expect(FEE_REWARDS_MANIFEST.vault.totalShares).toBe(100n * 10n ** 18n);
    expect(FEE_REWARDS_MANIFEST.campaign.feeShareAllocation).toBe(50n * 10n ** 18n);
    expect(FEE_REWARDS_MANIFEST.campaign.endAt - FEE_REWARDS_MANIFEST.campaign.startAt).toBe(
      7n * 24n * 60n * 60n,
    );
    expect(FEE_REWARDS_MANIFEST.campaign.sponsor).toBe(
      FEE_REWARDS_MANIFEST.vault.initialShareRecipient,
    );
  });

  it("pins every reviewed runtime identity", () => {
    expect(FEE_REWARDS_MANIFEST.adapter.runtimeCodeHash).toBe(
      "0xbfb40896738d786e657e3f524595ee43d98a7570f9ec162a1262b012a868d195",
    );
    expect(FEE_REWARDS_MANIFEST.vault.runtimeCodeHash).toBe(
      "0x4d62bd109d8fed9a04c02343cf6357dbf6d6789ef5ed9940b11add836c3caac4",
    );
    expect(FEE_REWARDS_MANIFEST.campaign.runtimeCodeHash).toBe(
      "0xdc3b2cc96fedbf6c7de50f4bfd0d5ad37b3039a0a30bde0510a559aba8393312",
    );
    expect(FEE_REWARDS_MANIFEST.campaign.deploymentBlock).toBe(25_451_599n);
  });
});

describe("campaignPhase", () => {
  const { startAt, endAt, claimDeadline } = FEE_REWARDS_MANIFEST.campaign;

  it("follows the contract's exact window boundaries", () => {
    expect(campaignPhase(startAt - 1n, false, false)).toBe("unfunded");
    expect(campaignPhase(startAt - 1n, true, false)).toBe("upcoming");
    expect(campaignPhase(startAt, true, false)).toBe("active");
    expect(campaignPhase(endAt - 1n, true, false)).toBe("active");
    expect(campaignPhase(endAt, true, false)).toBe("settlement-pending");
    expect(campaignPhase(endAt + 1n, true, true)).toBe("claim-only");
    expect(campaignPhase(claimDeadline, true, true)).toBe("claim-only");
    expect(campaignPhase(claimDeadline + 1n, true, true)).toBe("expired");
  });

  it("formats every phase for public UI copy", () => {
    expect(formatCampaignPhase("unfunded")).toBe("Unfunded");
    expect(formatCampaignPhase("upcoming")).toBe("Upcoming");
    expect(formatCampaignPhase("active")).toBe("Active");
    expect(formatCampaignPhase("settlement-pending")).toBe("Settlement pending");
    expect(formatCampaignPhase("claim-only")).toBe("Claim only");
    expect(formatCampaignPhase("expired")).toBe("Expired");
  });
});

describe("projectedPrincipalShare", () => {
  const E18 = 10n ** 18n;

  it("projects the stake's share of principal at the verified block", () => {
    expect(projectedPrincipalShare(100n * E18, 0n)).toBe(100);
    expect(projectedPrincipalShare(100n * E18, 100n * E18)).toBe(50);
    expect(projectedPrincipalShare(1n * E18, 999n * E18)).toBe(0.1);
    expect(projectedPrincipalShare(1n * E18, 3n * E18)).toBe(25);
  });

  it("truncates rather than rounding up, so a share is never overstated", () => {
    // 1/3 → 33.33%, not 33.34%.
    expect(projectedPrincipalShare(1n * E18, 2n * E18)).toBe(33.33);
  });

  it("stays silent when there is nothing to project", () => {
    expect(projectedPrincipalShare(0n, 100n * E18)).toBeNull();
    expect(projectedPrincipalShare(-1n, 100n * E18)).toBeNull();
    expect(projectedPrincipalShare(100n * E18, -1n)).toBeNull();
  });
});

describe("campaignCountdown", () => {
  const { startAt, endAt, claimDeadline } = FEE_REWARDS_MANIFEST.campaign;

  it("targets the manifest boundary each clock-bound phase waits on", () => {
    expect(campaignCountdown("upcoming")).toEqual({
      label: "Starts in",
      reachedLabel: "Start reached",
      target: startAt,
    });
    expect(campaignCountdown("active")).toEqual({
      label: "Ends in",
      reachedLabel: "End reached",
      target: endAt,
    });
    expect(campaignCountdown("claim-only")).toEqual({
      label: "Claims close in",
      reachedLabel: "Deadline reached",
      target: claimDeadline,
    });
  });

  it("offers no countdown for phases that do not wait on the clock", () => {
    expect(campaignCountdown("unfunded")).toBeNull();
    expect(campaignCountdown("settlement-pending")).toBeNull();
    expect(campaignCountdown("expired")).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("drops seconds on multi-day spans and pads non-leading units", () => {
    expect(formatCountdown(6n * 86_400n + 23n * 3_600n + 59n * 60n + 8n)).toBe("6d 23h 59m");
    expect(formatCountdown(86_400n)).toBe("1d 00h 00m");
    expect(formatCountdown(13n * 3_600n + 22n * 60n + 8n)).toBe("13h 22m 08s");
    expect(formatCountdown(9n * 3_600n + 5n * 60n + 3n)).toBe("9h 05m 03s");
    expect(formatCountdown(22n * 60n + 8n)).toBe("22m 08s");
    expect(formatCountdown(8n)).toBe("0m 08s");
    expect(formatCountdown(0n)).toBe("0m 00s");
  });

  it("clamps negative durations instead of showing a negative clock", () => {
    expect(formatCountdown(-30n)).toBe("0m 00s");
    expect(formatCountdown(-30n, "minute")).toBe("0m");
  });

  it("rounds minute granularity up so calm motion never understates", () => {
    expect(formatCountdown(61n, "minute")).toBe("2m");
    expect(formatCountdown(60n, "minute")).toBe("1m");
    expect(formatCountdown(59n, "minute")).toBe("1m");
    expect(formatCountdown(13n * 3_600n + 22n * 60n + 8n, "minute")).toBe("13h 23m");
    expect(formatCountdown(7n * 86_400n, "minute")).toBe("7d 00h 00m");
  });
});

describe("fee rewards ABIs", () => {
  it("keeps the user and operator actions explicit", () => {
    expect(functionNames(feeRewardsCampaignAbi)).toEqual(
      expect.arrayContaining([
        "stake",
        "stakeWithPermit",
        "withdraw",
        "exit",
        "claimFor",
        "harvest",
        "syncRewards",
        "checkpoint",
        "finalize",
        "sweepExpiredRewards",
      ]),
    );
    expect(functionNames(feeRewardsVaultAbi)).toEqual(
      expect.arrayContaining(["harvest", "sync", "claimFor", "claimCheckpointedFor"]),
    );
    expect(functionNames(permitTokenAbi)).toEqual(
      expect.arrayContaining(["allowance", "approve", "nonces", "eip712Domain"]),
    );
  });
});
