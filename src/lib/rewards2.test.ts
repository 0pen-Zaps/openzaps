import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { FEE_REWARDS_MANIFEST, feeRewardsVaultAbi } from "./rewards";
import {
  CAMPAIGN_2_LEGS,
  FEE_REWARDS_2_MANIFEST,
  deriveHookrPoolId,
  feeRewards2Deployment,
} from "./rewards2";

describe("campaign-2 manifest", () => {
  it("carries the verified release and both legs share one schedule", () => {
    const deployment = FEE_REWARDS_2_MANIFEST.deployment as unknown as {
      campaign: {
        address: string;
        runtimeCodeHash: string;
        deploymentBlock: bigint;
        startAt: bigint;
        endAt: bigint;
        claimDeadline: bigint;
      };
      hookBlocks: {
        address: string;
        runtimeCodeHash: string;
        deploymentBlock: bigint;
        startAt: bigint;
        endAt: bigint;
        sweepAfter: bigint;
      };
    };
    expect(feeRewards2Deployment()).toBe("configured");
    // Chain-verified identities of the 2026-08-20 release.
    expect(deployment.campaign.address).toBe("0x7F57F7B760614e67D3B3887433fA124B4c9A09F9");
    expect(deployment.hookBlocks.address).toBe("0xB5F7D9D4269c897Df70Df26F7bA48c0d933Be8Db");
    for (const leg of [deployment.campaign, deployment.hookBlocks]) {
      expect(leg.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(leg.deploymentBlock).toBeGreaterThan(0n);
    }
    // One schedule across both legs: a 14-day window and a 30-day tail.
    expect(deployment.campaign.startAt).toBe(deployment.hookBlocks.startAt);
    expect(deployment.campaign.endAt).toBe(deployment.hookBlocks.endAt);
    expect(deployment.campaign.claimDeadline).toBe(deployment.hookBlocks.sweepAfter);
    expect(deployment.campaign.endAt - deployment.campaign.startAt).toBe(
      FEE_REWARDS_2_MANIFEST.terms.durationSeconds,
    );
    expect(deployment.campaign.claimDeadline - deployment.campaign.endAt).toBe(30n * 86_400n);
  });

  it("proves the pinned HOOKR pool key hashes to the pinned poolId", () => {
    // A v4 poolId IS keccak256(abi.encode(key)); recomputing it makes a
    // mistyped fee, spacing, or currency unrepresentable in a green build.
    expect(deriveHookrPoolId()).toBe(FEE_REWARDS_2_MANIFEST.hookrPool.poolId);
  });

  it("pins the pool to the hookless native-ETH/HOOKR market", () => {
    const key = FEE_REWARDS_2_MANIFEST.hookrPool.key;
    expect(key.currency0).toBe("0x0000000000000000000000000000000000000000");
    expect(key.currency1).toBe(FEE_REWARDS_2_MANIFEST.hookr);
    expect(key.hooks).toBe("0x0000000000000000000000000000000000000000");
  });

  it("commits 100% of the tokenized stream, half to each leg", () => {
    const { stakerFeeShares, hookBlocksFeeShares } = FEE_REWARDS_2_MANIFEST.terms;
    expect(stakerFeeShares).toBe(hookBlocksFeeShares);
    expect(stakerFeeShares + hookBlocksFeeShares).toBe(
      FEE_REWARDS_2_MANIFEST.vault.totalShares,
    );
  });

  it("keeps a 14-day window and sane buy bounds", () => {
    const terms = FEE_REWARDS_2_MANIFEST.terms;
    expect(terms.durationSeconds).toBe(14n * 86_400n);
    expect(terms.minOutBps).toBeGreaterThan(0);
    expect(terms.minOutBps).toBeLessThanOrEqual(10_000);
    expect(terms.minBuyWei).toBeLessThanOrEqual(terms.maxBuyWei);
    expect(terms.maxBuyWei).toBeLessThanOrEqual(2n ** 128n - 1n);
  });

  it("shares the campaign-1 stack's live identities", () => {
    // Same vault, same reward asset, same staking token, same sponsor: leg A
    // is the proven artifact on a new term, not a new economics surface.
    expect(FEE_REWARDS_2_MANIFEST.vault.address).toBe(FEE_REWARDS_MANIFEST.vault.address);
    expect(FEE_REWARDS_2_MANIFEST.weth).toBe(FEE_REWARDS_MANIFEST.weth);
    expect(FEE_REWARDS_2_MANIFEST.token).toBe(FEE_REWARDS_MANIFEST.token);
    expect(FEE_REWARDS_2_MANIFEST.sponsor).toBe(FEE_REWARDS_MANIFEST.campaign.sponsor);
    expect(FEE_REWARDS_2_MANIFEST.vault.totalShares).toBe(
      FEE_REWARDS_MANIFEST.vault.totalShares,
    );
    expect(FEE_REWARDS_2_MANIFEST.vault.runtimeCodeHash).toBe(
      FEE_REWARDS_MANIFEST.vault.runtimeCodeHash,
    );
  });

  it("pins checkpoint recovery to the shared vault and HookBlocks recipient", () => {
    const hookBlocks = FEE_REWARDS_2_MANIFEST.deployment.hookBlocks.address;
    expect(
      encodeFunctionData({
        abi: feeRewardsVaultAbi,
        functionName: "claimCheckpointedFor",
        args: [hookBlocks],
      }),
    ).toBe(
      "0x709ce5d4000000000000000000000000b5f7d9d4269c897df70df26f7ba48c0d933be8db",
    );
  });

  it("describes exactly two legs with mechanism language only", () => {
    expect(CAMPAIGN_2_LEGS.map((leg) => leg.id)).toEqual(["stakers", "hook-blocks"]);
    const copy = JSON.stringify(CAMPAIGN_2_LEGS).toLowerCase();
    // The claims register: no yield, return, or price-support vocabulary.
    for (const banned of ["apy", "apr", "yield", "deflation", "price support", "guaranteed"]) {
      expect(copy).not.toContain(banned);
    }
    // The permanence claim must be stated as construction.
    expect(copy).toContain("dead address");
    expect(copy).toContain("append-only");
    // The burn must never be sold as supply reduction: the token has no burn
    // function, so totalSupply is unchanged and saying otherwise is false.
    expect(copy).toContain("without reducing totalsupply");
  });
});
