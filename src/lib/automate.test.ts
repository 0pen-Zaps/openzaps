import { describe, expect, it } from "vitest";
import { parseEther, type Address } from "viem";

import {
  INTERVAL_PRESETS,
  OPEN_EXECUTOR,
  resolveExecutor,
  THRESHOLD_PRESETS,
  defaultSlippageBps,
  describeSeries,
  draftRecurringIntent,
  draftRecurringRelativeIntent,
  draftTriggerIntent,
  feedConditionForZapsMove,
  fundingReadiness,
  intentFileName,
  netFloorFromQuote,
  planWethFunding,
  projectedRelativeFloor,
  readAutomationHandoff,
  requiredFunding,
  suggestedSeriesDeadline,
} from "@/lib/automate";
import { computeExecutorFeeSplit } from "@/lib/executions";
import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/execution-policy";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as Address;
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270" as const;

describe("readAutomationHandoff", () => {
  it("accepts a complete recurring builder handoff", () => {
    const params = new URLSearchParams({
      src: "build",
      mode: "recurring",
      route: "robinhood-v4-weth-zaps",
      amount: "0.001",
      bps: "100",
      interval: "monthly",
      runs: "12",
    });
    expect(readAutomationHandoff(params)).toEqual({
      mode: "recurring",
      routeId: "robinhood-v4-weth-zaps",
      amount: "0.001",
      slippageBps: 100,
      intervalId: "monthly",
      maxRuns: 12,
      thresholdId: "up10",
      validDays: null,
      executionPolicy: DEFAULT_EXECUTION_POLICY,
    });
  });

  it("accepts a complete trigger handoff and rejects partial or unsupported input", () => {
    const trigger = new URLSearchParams({
      src: "build",
      mode: "trigger",
      route: "robinhood-v4-zaps-weth",
      amount: "100000",
      bps: "200",
      threshold: "down25",
      days: "90",
    });
    expect(readAutomationHandoff(trigger)?.thresholdId).toBe("down25");
    trigger.set("maxGas", "1750000");
    trigger.set("maxFeeGwei", "4");
    trigger.set("executor", "owner");
    expect(readAutomationHandoff(trigger)?.executionPolicy).toEqual({
      maxGas: 1_750_000,
      maxFeePerGasGwei: 4,
      executorAccess: "owner-only",
    });
    expect(readAutomationHandoff(new URLSearchParams("src=build&mode=trigger"))).toBeNull();
    trigger.set("route", "robinhood-v4-weth-usdg");
    expect(readAutomationHandoff(trigger)).toBeNull();
  });
});

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

  it("carries custom execution caps into every signed intent and rejects unsafe bounds", () => {
    const it_ = draftTriggerIntent({
      zap: ZAP,
      chainId: 4663,
      nonce: 8n,
      nowSec: 1_000_000n,
      validDays: 30,
      priceSource: ADDR,
      baselinePriceX96: 1n,
      thresholdBps: 500,
      above: false,
      recipient: ADDR,
      policyHash: HASH,
      outAsset: ADDR,
      minOut: 1n,
      maxGas: 1_500_000n,
      maxFeePerGas: 3_000_000_000n,
    });
    expect(it_.maxGas).toBe(1_500_000n);
    expect(it_.maxFeePerGas).toBe(3_000_000_000n);
    expect(() => draftTriggerIntent({
      ...it_,
      chainId: 4663,
      nowSec: 1_000_000n,
      validDays: 30,
      maxGas: MAX_EXECUTION_GAS + 1n,
    })).toThrow("Execution gas limit");
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

  it("binds an explicit builder expiry and rejects one that truncates the schedule", () => {
    const explicit = draftRecurringRelativeIntent({ ...baseRel, validDays: 7 });
    expect(explicit.deadline).toBe(7n * 86_400n);
    expect(() => draftRecurringRelativeIntent({ ...baseRel, interval: 604_800n, maxRuns: 10, validDays: 30 })).toThrow(
      "ends before all scheduled runs",
    );
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

describe("fundingReadiness", () => {
  it("reports unknown while the wallet balance has not read (never blocks on a missing read)", () => {
    expect(fundingReadiness(null, parseEther("1"))).toEqual({ status: "unknown", shortfall: 0n });
    expect(fundingReadiness(null, 0n)).toEqual({ status: "unknown", shortfall: 0n });
  });

  it("is sufficient when nothing is owed, regardless of balance", () => {
    expect(fundingReadiness(0n, 0n)).toEqual({ status: "sufficient", shortfall: 0n });
    expect(fundingReadiness(0n, -5n)).toEqual({ status: "sufficient", shortfall: 0n });
  });

  it("is sufficient when the wallet meets or exceeds the need (boundary is inclusive)", () => {
    expect(fundingReadiness(parseEther("1"), parseEther("1"))).toEqual({ status: "sufficient", shortfall: 0n });
    expect(fundingReadiness(parseEther("2"), parseEther("1"))).toEqual({ status: "sufficient", shortfall: 0n });
  });

  it("is short by the exact gap when the wallet cannot cover the transfer", () => {
    expect(fundingReadiness(parseEther("0.3"), parseEther("1"))).toEqual({
      status: "short",
      shortfall: parseEther("0.7"),
    });
    expect(fundingReadiness(0n, 1n)).toEqual({ status: "short", shortfall: 1n });
  });
});

describe("planWethFunding", () => {
  const RESERVE = parseEther("0.0005");

  it("needs no wrap when aeWETH already covers the deposit", () => {
    expect(planWethFunding({ needed: parseEther("1"), wethBalance: parseEther("1"), ethBalance: parseEther("9"), gasReserve: RESERVE }))
      .toEqual({ status: "sufficient", shortfall: 0n, wrapEth: 0n });
    // nothing owed → sufficient regardless of balances
    expect(planWethFunding({ needed: 0n, wethBalance: 0n, ethBalance: 0n, gasReserve: RESERVE }))
      .toEqual({ status: "sufficient", shortfall: 0n, wrapEth: 0n });
  });

  it("wraps exactly the gap from ETH when aeWETH is short but ETH covers it", () => {
    // need 1 aeWETH, hold 0.3 aeWETH → wrap 0.7 ETH; wallet has 2 ETH (>> 0.7 + reserve)
    const plan = planWethFunding({ needed: parseEther("1"), wethBalance: parseEther("0.3"), ethBalance: parseEther("2"), gasReserve: RESERVE });
    expect(plan).toEqual({ status: "sufficient", shortfall: 0n, wrapEth: parseEther("0.7") });
  });

  it("wraps straight from ETH with zero aeWETH held", () => {
    const plan = planWethFunding({ needed: parseEther("0.05"), wethBalance: 0n, ethBalance: parseEther("0.05") + RESERVE, gasReserve: RESERVE });
    expect(plan).toEqual({ status: "sufficient", shortfall: 0n, wrapEth: parseEther("0.05") });
  });

  it("reserves gas: cannot wrap the reserve, so a wallet with exactly the gap is short", () => {
    // gap 1 ETH, wallet holds exactly 1 ETH → spendable = 1 - reserve < 1 → short by the reserve
    const plan = planWethFunding({ needed: parseEther("1"), wethBalance: 0n, ethBalance: parseEther("1"), gasReserve: RESERVE });
    expect(plan.status).toBe("short");
    expect(plan.shortfall).toBe(RESERVE);
    expect(plan.wrapEth).toBe(0n);
  });

  it("never over-wraps: wrapEth equals the gap, not the whole ETH balance", () => {
    const plan = planWethFunding({ needed: parseEther("0.5"), wethBalance: parseEther("0.1"), ethBalance: parseEther("100"), gasReserve: RESERVE });
    expect(plan.wrapEth).toBe(parseEther("0.4")); // 0.5 - 0.1, not 100
  });

  it("is unknown while either balance it needs has not read", () => {
    // aeWETH unread → unknown regardless of ETH
    expect(planWethFunding({ needed: parseEther("1"), wethBalance: null, ethBalance: parseEther("9"), gasReserve: RESERVE }).status).toBe("unknown");
    // aeWETH short but ETH unread → cannot confirm the wrap → unknown, not short
    expect(planWethFunding({ needed: parseEther("1"), wethBalance: parseEther("0.3"), ethBalance: null, gasReserve: RESERVE }).status).toBe("unknown");
    // aeWETH already covers → sufficient even if ETH unread (ETH not needed)
    expect(planWethFunding({ needed: parseEther("1"), wethBalance: parseEther("1"), ethBalance: null, gasReserve: RESERVE }).status).toBe("sufficient");
  });

  it("reports the exact ETH shortfall when even wrapping everything spendable falls short", () => {
    // need 1, hold 0.2 aeWETH → gap 0.8; ETH 0.5 → spendable 0.5-reserve; short by 0.8 - (0.5-reserve)
    const plan = planWethFunding({ needed: parseEther("1"), wethBalance: parseEther("0.2"), ethBalance: parseEther("0.5"), gasReserve: RESERVE });
    expect(plan.status).toBe("short");
    expect(plan.shortfall).toBe(parseEther("0.8") - (parseEther("0.5") - RESERVE));
    expect(plan.wrapEth).toBe(0n);
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

describe("executor pinning", () => {
  const PINNED = "0x11DB3AF89b626ab1e09EDb8223af836D1Bee9347" as Address;

  it("leaves a run open to anyone by default", () => {
    // Open is the liveness default: whoever gets there first may submit, and the
    // capsule still refuses every run it does not owe.
    expect(resolveExecutor()).toBe(OPEN_EXECUTOR);
    expect(resolveExecutor(null)).toBe(OPEN_EXECUTOR);
    expect(OPEN_EXECUTOR).toBe("0x0000000000000000000000000000000000000000");
  });

  it("pins a single submitter when one is chosen", () => {
    expect(resolveExecutor(PINNED)).toBe(PINNED);
  });

  it("carries the choice into every execution type", () => {
    const common = { chainId: 4663, nowSec: 1_000_000n, recipient: ADDR, policyHash: HASH, outAsset: ADDR, zap: ZAP };
    const recurring = draftRecurringIntent({
      ...common, seriesId: 1n, interval: 86_400n, maxRuns: 5, minOutPerRun: 0n, executor: PINNED,
    });
    const relative = draftRecurringRelativeIntent({
      ...common, seriesId: 1n, interval: 86_400n, maxRuns: 5, priceSource: ADDR, maxSlippageBps: 500, executor: PINNED,
    });
    const trigger = draftTriggerIntent({
      ...common, nonce: 7n, validDays: 30, priceSource: ADDR, baselinePriceX96: 1n, thresholdBps: 1_000,
      above: true, minOut: 0n, executor: PINNED,
    });
    for (const intent of [recurring, relative, trigger]) expect(intent.executor).toBe(PINNED);

    // …and omitting it still yields an open intent on every type.
    expect(draftRecurringIntent({ ...common, seriesId: 1n, interval: 86_400n, maxRuns: 5, minOutPerRun: 0n }).executor)
      .toBe(OPEN_EXECUTOR);
  });
});
