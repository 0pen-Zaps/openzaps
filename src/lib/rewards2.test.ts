import { describe, expect, it } from "vitest";

import { FEE_REWARDS_MANIFEST } from "./rewards";
import {
  CAMPAIGN_2_LEGS,
  FEE_REWARDS_2_MANIFEST,
  deriveHookrPoolId,
  feeRewards2Deployment,
} from "./rewards2";

describe("campaign-2 manifest", () => {
  it("fails closed until a reviewed deployment lands", () => {
    // The not-live state is deliberate: null deployment, absent surface.
    expect(FEE_REWARDS_2_MANIFEST.deployment).toBeNull();
    expect(feeRewards2Deployment()).toBe("absent");
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
