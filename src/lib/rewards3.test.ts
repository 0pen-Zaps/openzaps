import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEE_REWARDS_2_MANIFEST } from "./rewards2";
import { FEE_REWARDS_3_MANIFEST, feeRewards3Deployment } from "./rewards3";

const solidityTerms = readFileSync(
  join(process.cwd(), "contracts/script/Campaign3Terms.sol"),
  "utf8",
);

function solidityIntegerConstant(name: string): bigint {
  const match = solidityTerms.match(new RegExp(`\\b${name}\\s*=\\s*([0-9_]+);`));
  if (!match?.[1]) throw new Error(`Missing Solidity term ${name}`);
  return BigInt(match[1].replaceAll("_", ""));
}

describe("Campaign 3 prepared release manifest", () => {
  it("pins the requested October 1–31 UTC window and 30-day tails", () => {
    const { schedule, terms } = FEE_REWARDS_3_MANIFEST;

    expect(schedule.startAt).toBe(1_790_812_800n);
    expect(schedule.endAt).toBe(1_793_491_200n);
    expect(schedule.claimDeadline).toBe(1_796_083_200n);
    expect(schedule.sweepAfter).toBe(1_796_083_200n);
    expect(schedule.endAt - schedule.startAt).toBe(31n * 86_400n);
    expect(schedule.claimDeadline - schedule.endAt).toBe(30n * 86_400n);
    expect(schedule.sweepAfter - schedule.endAt).toBe(30n * 86_400n);
    expect(terms.durationSeconds).toBe(31n * 86_400n);
    expect(terms.sweepTailSeconds).toBe(30n * 86_400n);
  });

  it("matches the Solidity deployment constants to the UI manifest", () => {
    const { schedule, terms } = FEE_REWARDS_3_MANIFEST;

    expect(solidityIntegerConstant("START_AT")).toBe(schedule.startAt);
    expect(solidityIntegerConstant("END_AT")).toBe(schedule.endAt);
    expect(solidityIntegerConstant("CLAIM_DEADLINE")).toBe(schedule.claimDeadline);
    expect(solidityIntegerConstant("SWEEP_AFTER")).toBe(schedule.sweepAfter);
    expect(solidityIntegerConstant("MIN_OUT_BPS")).toBe(BigInt(terms.minOutBps));
    expect(solidityTerms).toContain("DURATION_SECONDS = 31 days;");
    expect(solidityTerms).toContain("SWEEP_TAIL = 30 days;");
    expect(solidityTerms).toContain("STAKER_FEE_SHARES = 50e18;");
    expect(solidityTerms).toContain("HOOK_BLOCKS_FEE_SHARES = 50e18;");
    expect(solidityTerms).toContain("MAX_BUY_WEI = 0.05 ether;");
    expect(solidityTerms).toContain("MIN_BUY_WEI = 0.0005 ether;");
    expect(solidityTerms).toContain("MIN_FUNDING_LEAD = 24 hours;");
  });

  it("matches Campaign 2's per-leg economics while making the longer window explicit", () => {
    expect(FEE_REWARDS_3_MANIFEST.terms.stakerFeeShares).toBe(
      FEE_REWARDS_2_MANIFEST.terms.stakerFeeShares,
    );
    expect(FEE_REWARDS_3_MANIFEST.terms.hookBlocksFeeShares).toBe(
      FEE_REWARDS_2_MANIFEST.terms.hookBlocksFeeShares,
    );
    expect(FEE_REWARDS_3_MANIFEST.terms.minOutBps).toBe(
      FEE_REWARDS_2_MANIFEST.terms.minOutBps,
    );
    expect(FEE_REWARDS_3_MANIFEST.terms.maxBuyWei).toBe(
      FEE_REWARDS_2_MANIFEST.terms.maxBuyWei,
    );
    expect(FEE_REWARDS_3_MANIFEST.terms.minBuyWei).toBe(
      FEE_REWARDS_2_MANIFEST.terms.minBuyWei,
    );
    expect(FEE_REWARDS_2_MANIFEST.terms.durationSeconds).toBe(14n * 86_400n);
    expect(FEE_REWARDS_3_MANIFEST.terms.durationSeconds).toBe(31n * 86_400n);
  });

  it("keeps reads and writes fail-closed until both complete deployments match the reviewed schedule", () => {
    const { schedule } = FEE_REWARDS_3_MANIFEST;
    const campaign = {
      address: "0x1111111111111111111111111111111111111111",
      runtimeCodeHash: `0x${"a".repeat(64)}`,
      deploymentBlock: 1n,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      claimDeadline: schedule.claimDeadline,
    };
    const hookBlocks = {
      address: "0x2222222222222222222222222222222222222222",
      runtimeCodeHash: `0x${"b".repeat(64)}`,
      deploymentBlock: 2n,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      sweepAfter: schedule.sweepAfter,
    };

    expect(feeRewards3Deployment()).toBe("absent");
    expect(feeRewards3Deployment({ deployment: null })).toBe("absent");
    expect(feeRewards3Deployment({ deployment: { campaign: {}, hookBlocks: null } })).toBe("partial");
    expect(feeRewards3Deployment({ deployment: { campaign: {}, hookBlocks: {} } })).toBe("partial");
    expect(feeRewards3Deployment({ deployment: { campaign, hookBlocks } })).toBe("configured");
    expect(
      feeRewards3Deployment({
        deployment: {
          campaign,
          hookBlocks: { ...hookBlocks, startAt: schedule.startAt + 1n },
        },
      }),
    ).toBe("partial");
    expect(
      feeRewards3Deployment({
        deployment: {
          campaign,
          hookBlocks: { ...hookBlocks, address: campaign.address },
        },
      }),
    ).toBe("partial");
  });
});
