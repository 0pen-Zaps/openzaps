import { describe, expect, it } from "vitest";
import { parseEther, type Address } from "viem";

import {
  INTERVAL_PRESETS,
  THRESHOLD_PRESETS,
  defaultSlippageBps,
  describeSeries,
  draftRecurringIntent,
  draftRecurringRelativeIntent,
  draftTriggerIntent,
  feedConditionForZapsMove,
  intentFileName,
  netFloorFromQuote,
  projectedRelativeFloor,
  requiredFunding,
  suggestedSeriesDeadline,
} from "@/lib/automate";
import { computeExecutorFeeSplit } from "@/lib/executions";
import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as Address;
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270" as const;

describe("requiredFunding", () => {
  it("multiplies by runs for recurring, single amount for trigger", () => {
    expect(requiredFunding(parseEther("1"), "recurring", 30)).toBe(parseEther("30"));
    expect(requiredFunding(parseEther("1"), "trigger", 30)).toBe(parseEther("1"));
    expect(requiredFunding(parseEther("1"), "recurring", 0)).toBe(0n);
  });
});

describe("netFloorFromQuote", () => {
  it("applies slippage then the 1% executor fee (the capsule checks net)", () => {
    // 100 out, 50 bps slippage → gross floor 99.5 → minus 1% fee → 98.505
    const floor = netFloorFromQuote(parseEther("100"), 50);
    expect(floor).toBe(computeExecutorFeeSplit(parseEther("99.5")).net);
    expect(floor).toBe(parseEther("98.505"));
  });

  it("clamps garbage inputs closed", () => {
    expect(netFloorFromQuote(0n, 50)).toBe(0n);
    expect(netFloorFromQuote(-1n, 50)).toBe(0n);
    expect(netFloorFromQuote(parseEther("1"), -5)).toBe(computeExecutorFeeSplit(parseEther("1")).net);
    // 10_000+ bps clamps to 9_999, never a negative floor
    expect(netFloorFromQuote(parseEther("1"), 20_000)).toBeGreaterThanOrEqual(0n);
  });
});

describe("suggestedSeriesDeadline", () => {
  it("covers the full series plus headroom, minimum a day", () => {
    const now = 1_000_000n;
    // 30 daily runs: span 2,592,000s; headroom = span/4 = 648,000 > 86,400
    expect(suggestedSeriesDeadline(now, 86_400n, 30)).toBe(now + 2_592_000n + 648_000n);
    // 2 hourly runs: span 7,200; headroom floors at 86,400
    expect(suggestedSeriesDeadline(now, 3_600n, 2)).toBe(now + 7_200n + 86_400n);
  });
});

describe("intent drafting", () => {
  it("drafts a recurring intent with open executor and protocol gas caps", () => {
    const it_ = draftRecurringIntent({
      zap: ZAP,
      chainId: 4663,
      seriesId: 42n,
      nowSec: 1_000_000n,
      interval: 86_400n,
      maxRuns: 30,
      recipient: ADDR,
      policyHash: HASH,
      outAsset: ADDR,
      minOutPerRun: parseEther("98"),
    });
    expect(it_.executor).toBe("0x0000000000000000000000000000000000000000");
    expect(it_.maxGas).toBe(MAX_EXECUTION_GAS);
    expect(it_.maxFeePerGas).toBe(MAX_EXECUTION_FEE_PER_GAS);
    expect(it_.chainId).toBe(4663n);
    expect(it_.deadline).toBe(suggestedSeriesDeadline(1_000_000n, 86_400n, 30));
  });

  it("drafts a trigger intent bounded to the requested window", () => {
    const it_ = draftTriggerIntent({
      zap: ZAP,
      chainId: 4663,
      nonce: 7n,
      nowSec: 1_000_000n,
      validDays: 30,
      priceSource: ADDR,
      baselinePriceX96: parseEther("1000"),
      thresholdBps: 1_000,
      above: true,
      recipient: ADDR,
      policyHash: HASH,
      outAsset: ADDR,
      minOut: parseEther("98"),
    });
    expect(it_.deadline).toBe(1_000_000n + 30n * 86_400n);
    expect(it_.thresholdBps).toBe(1_000);
    expect(it_.above).toBe(true);
  });
});

describe("presets", () => {
  it("interval presets are strictly increasing and nonzero", () => {
    let prev = 0n;
    for (const p of INTERVAL_PRESETS) {
      expect(p.seconds).toBeGreaterThan(prev);
      prev = p.seconds;
    }
  });

  it("threshold presets convert to conditions inside the capsule's validity bounds", () => {
    for (const p of THRESHOLD_PRESETS) {
      const cond = feedConditionForZapsMove(p.moveBps, p.rises);
      expect(cond.thresholdBps).toBeGreaterThan(0);
      if (!cond.above) expect(cond.thresholdBps).toBeLessThan(10_000);
      expect(cond.thresholdBps).toBeLessThanOrEqual(1_000_000);
    }
  });
});

describe("feedConditionForZapsMove — the direction inversion", () => {
  // The feed is 0xZAPS-per-aeWETH: it FALLS when 0xZAPS gains value. A signed condition in the
  // token's own direction executes the trade on the OPPOSITE market move, so these values are
  // pinned exactly — any drift here is a critical bug, not a rounding nit.
  it("token RISES map to feed FALLS (above=false) with reciprocal magnitude", () => {
    expect(feedConditionForZapsMove(500, true)).toEqual({ above: false, thresholdBps: 476 }); // +5% ⇒ −4.76%
    expect(feedConditionForZapsMove(1_000, true)).toEqual({ above: false, thresholdBps: 909 }); // +10% ⇒ −9.09%
    expect(feedConditionForZapsMove(2_500, true)).toEqual({ above: false, thresholdBps: 2_000 }); // +25% ⇒ −20%
  });

  it("token FALLS map to feed RISES (above=true) with reciprocal magnitude", () => {
    expect(feedConditionForZapsMove(500, false)).toEqual({ above: true, thresholdBps: 526 }); // −5% ⇒ +5.26%
    expect(feedConditionForZapsMove(1_000, false)).toEqual({ above: true, thresholdBps: 1_111 }); // −10% ⇒ +11.11%
    expect(feedConditionForZapsMove(2_500, false)).toEqual({ above: true, thresholdBps: 3_333 }); // −25% ⇒ +33.33%
  });

  it("rejects meaningless moves", () => {
    expect(() => feedConditionForZapsMove(0, true)).toThrow();
    expect(() => feedConditionForZapsMove(-100, true)).toThrow();
    expect(() => feedConditionForZapsMove(10_000, false)).toThrow();
  });
});

describe("describeSeries", () => {
  const intent = draftRecurringIntent({
    zap: ZAP,
    chainId: 4663,
    seriesId: 1n,
    nowSec: 0n,
    interval: 3_600n,
    maxRuns: 3,
    recipient: ADDR,
    policyHash: HASH,
    outAsset: ADDR,
    minOutPerRun: 0n,
  });

  it("narrates progress through the series", () => {
    expect(describeSeries(0, 0n, intent, 100n)).toContain("first run is available now");
    expect(describeSeries(1, 100n, intent, 200n)).toContain("next run in ~");
    expect(describeSeries(1, 100n, intent, 3_700n)).toContain("due now");
    expect(describeSeries(3, 100n, intent, 200n)).toContain("series complete");
  });
});

describe("intentFileName", () => {
  it("derives a stable per-capsule name", () => {
    expect(intentFileName("recurring", ZAP)).toBe("openzap-recurring-9941dd72.json");
    expect(intentFileName("trigger", ZAP)).toBe("openzap-trigger-9941dd72.json");
  });
});

describe("draftRecurringRelativeIntent", () => {
  it("carries priceSource + clamped maxSlippageBps instead of an absolute floor", () => {
    const it_ = draftRecurringRelativeIntent({
      zap: ZAP,
      chainId: 4663,
      seriesId: 9n,
      nowSec: 1_000_000n,
      interval: 86_400n,
      maxRuns: 10,
      recipient: ADDR,
      policyHash: HASH,
      outAsset: ADDR,
      priceSource: ADDR,
      maxSlippageBps: 500,
    });
    expect(it_.priceSource).toBe(ADDR);
    expect(it_.maxSlippageBps).toBe(500);
    expect(it_.executor).toBe("0x0000000000000000000000000000000000000000");
    expect(it_.deadline).toBe(suggestedSeriesDeadline(1_000_000n, 86_400n, 10));
    expect("minOutPerRun" in it_).toBe(false);
    // clamps out-of-range slippage to the capsule's valid band [1, 9999]
    expect(draftRecurringRelativeIntent({ ...baseRel, maxSlippageBps: 0 }).maxSlippageBps).toBe(1);
    expect(draftRecurringRelativeIntent({ ...baseRel, maxSlippageBps: 20_000 }).maxSlippageBps).toBe(9_999);
  });
});

const baseRel = {
  zap: ZAP,
  chainId: 4663,
  seriesId: 1n,
  nowSec: 0n,
  interval: 86_400n,
  maxRuns: 5,
  recipient: ADDR,
  policyHash: HASH,
  outAsset: ADDR,
  priceSource: ADDR,
  maxSlippageBps: 500,
};

describe("projectedRelativeFloor", () => {
  // Mirrors OpenZapV3_1._relativeFloor. currency0 = aeWETH, currency1 = 0xZAPS;
  // priceX96 = currency1 per currency0 (Q96). These values are pinned to the contract math — any
  // drift here means the preview would lie about the floor the owner actually signed.
  const Q96 = 1n << 96n;
  const C0 = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address; // currency0 (input for a buy)
  const C1 = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07" as Address; // currency1 (0xZAPS)
  const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

  it("buying currency1 with currency0: floor = amountIn * price * (1 - slip)", () => {
    // spot = 1000 currency1 per currency0; 1 c0 in → 1000 c1 expected → 5% band → 950 floor
    const floor = projectedRelativeFloor({
      amountIn: parseEther("1"), outAsset: C1, currency0: C0, currency1: C1, priceX96: 1000n * Q96, maxSlippageBps: 500,
    });
    expect(floor).toBe(parseEther("950"));
  });

  it("buying currency0 with currency1: uses the reciprocal price", () => {
    // 1000 c1 in at 1000 c1/c0 → 1 c0 expected → 2% band → 0.98 floor
    const floor = projectedRelativeFloor({
      amountIn: parseEther("1000"), outAsset: C0, currency0: C0, currency1: C1, priceX96: 1000n * Q96, maxSlippageBps: 200,
    });
    expect(floor).toBe(parseEther("0.98"));
  });

  it("compares assets case-insensitively (checksummed intent vs lowercased source)", () => {
    const floor = projectedRelativeFloor({
      amountIn: parseEther("1"), outAsset: C1,
      currency0: C0.toLowerCase() as Address, currency1: C1.toLowerCase() as Address,
      priceX96: 1000n * Q96, maxSlippageBps: 500,
    });
    expect(floor).toBe(parseEther("950"));
  });

  it("mirrors the contract's mulDiv flooring on a non-round price", () => {
    const priceX96 = (1234567n * Q96) / 1000n; // 1234.567 c1/c0 — not exactly Q96-representable
    const amountIn = 3n * 10n ** 17n; // 0.3 c0
    const expected = (amountIn * priceX96) / Q96;
    const want = (expected * (10_000n - 500n)) / 10_000n;
    expect(
      projectedRelativeFloor({ amountIn, outAsset: C1, currency0: C0, currency1: C1, priceX96, maxSlippageBps: 500 }),
    ).toBe(want);
  });

  it("returns 0n (caller renders '—') for every degenerate input", () => {
    const base = { amountIn: parseEther("1"), outAsset: C1, currency0: C0, currency1: C1, priceX96: 1000n * Q96, maxSlippageBps: 500 };
    expect(projectedRelativeFloor({ ...base, amountIn: 0n })).toBe(0n);
    expect(projectedRelativeFloor({ ...base, priceX96: 0n })).toBe(0n);
    expect(projectedRelativeFloor({ ...base, maxSlippageBps: 10_000 })).toBe(0n); // >= 100% disables the floor
    expect(projectedRelativeFloor({ ...base, maxSlippageBps: -1 })).toBe(0n);
    expect(projectedRelativeFloor({ ...base, outAsset: OTHER })).toBe(0n); // outAsset not in the pair
    expect(projectedRelativeFloor({ ...base, amountIn: 1n, priceX96: 1n })).toBe(0n); // expected floors to zero
  });
});

describe("defaultSlippageBps", () => {
  it("gives recurring a wider band than a one-shot trigger", () => {
    // A recurring series signs ONE floor for many runs over time, so it must tolerate more drift.
    expect(defaultSlippageBps("recurring")).toBeGreaterThan(defaultSlippageBps("trigger"));
    expect(defaultSlippageBps("recurring")).toBe(500);
    expect(defaultSlippageBps("trigger")).toBe(200);
  });
});
