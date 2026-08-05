import { describe, expect, it } from "vitest";

import {
  DEFAULT_CREDIT_INPUTS,
  liquidationShockPct,
  recursiveExposureMultiple,
  simulateCredit,
  validateCreditInputs,
} from "./credit-model";

describe("agent credit design model", () => {
  it("keeps financed assets out of origination power", () => {
    const buy = simulateCredit({
      ...DEFAULT_CREDIT_INPUTS,
      strategy: "buy-zaps",
      zapsShockPct: 0,
    });
    const lp = simulateCredit({
      ...DEFAULT_CREDIT_INPUTS,
      strategy: "agent-lp",
      zapsShockPct: 0,
    });

    expect(buy.borrowLimitUsd).toBe(2_000);
    expect(lp.borrowLimitUsd).toBe(2_000);
    expect(buy.borrowLimitUsd).toBe(DEFAULT_CREDIT_INPUTS.collateralUsd * 0.2);
  });

  it("never exposes borrowed stablecoins as an arbitrary wallet balance", () => {
    for (const strategy of ["buy-zaps", "agent-lp"] as const) {
      const result = simulateCredit({
        ...DEFAULT_CREDIT_INPUTS,
        strategy,
        zapsShockPct: -40,
      });

      expect(result.borrowedStableUnits).toBe(DEFAULT_CREDIT_INPUTS.borrowUsd);
      expect(result.withdrawableBorrowedStableUnits).toBe(0);
    }
  });

  it("reconciles both strategies before rates, fees, haircuts, or shocks", () => {
    const inputs = {
      ...DEFAULT_CREDIT_INPUTS,
      days: 0,
      borrowAprPct: 0,
      lpFeeAprPct: 0,
      executionCostPct: 0,
      oracleHaircutPct: 0,
      liquidityDiscountPct: 0,
    };

    const buy = simulateCredit({ ...inputs, strategy: "buy-zaps", zapsShockPct: 0 });
    const lp = simulateCredit({ ...inputs, strategy: "agent-lp", zapsShockPct: 0 });

    expect(buy.markCollateralUsd).toBe(12_000);
    expect(lp.markCollateralUsd).toBe(12_000);
    expect(buy.debtUsd).toBe(2_000);
    expect(lp.debtUsd).toBe(2_000);
    expect(buy.netEquityUsd).toBe(10_000);
    expect(lp.netEquityUsd).toBe(10_000);
  });

  it("prices a full-range LP with the constant-product square-root identity", () => {
    const result = simulateCredit({
      ...DEFAULT_CREDIT_INPUTS,
      days: 0,
      borrowAprPct: 0,
      lpFeeAprPct: 0,
      executionCostPct: 0,
      oracleHaircutPct: 0,
      strategy: "agent-lp",
      zapsShockPct: -75,
    });

    // $8k unpaired collateral falls to $2k; the $4k LP falls to $2k.
    expect(result.markCollateralUsd).toBeCloseTo(4_000, 8);
    expect(result.impermanentLossPct).toBeCloseTo(-20, 8);
  });

  it("finds the analytical buy-strategy liquidation boundary", () => {
    const inputs = {
      ...DEFAULT_CREDIT_INPUTS,
      days: 0,
      borrowAprPct: 0,
      executionCostPct: 0,
      oracleHaircutPct: 0,
      liquidationLtvPct: 35,
    };

    // 2,000 / (35% × 12,000) = 47.619% of the entry price.
    expect(liquidationShockPct(inputs, "buy-zaps")).toBeCloseTo(-52.380_952, 5);
  });

  it("makes bad debt weakly increase as 0xZAPS falls", () => {
    const shocks = [-20, -40, -60, -80];
    const badDebt = shocks.map((zapsShockPct) =>
      simulateCredit({
        ...DEFAULT_CREDIT_INPUTS,
        strategy: "buy-zaps",
        zapsShockPct,
      }).badDebtUsd,
    );

    expect(badDebt).toEqual([...badDebt].sort((a, b) => a - b));
  });

  it("quantifies why recursively collateralising financed assets is unsafe", () => {
    expect(recursiveExposureMultiple(20)).toBeCloseTo(1.25);
    expect(recursiveExposureMultiple(50)).toBeCloseTo(2);
    expect(recursiveExposureMultiple(70)).toBeCloseTo(3.333_333);
  });

  it("rejects invalid market parameters", () => {
    expect(() =>
      validateCreditInputs({
        ...DEFAULT_CREDIT_INPUTS,
        borrowLtvPct: 40,
        liquidationLtvPct: 35,
      }),
    ).toThrow(/below liquidationLtvPct/);
    expect(() =>
      validateCreditInputs({ ...DEFAULT_CREDIT_INPUTS, borrowUsd: 10_001 }),
    ).toThrow(/cannot exceed/);
    expect(() => recursiveExposureMultiple(100)).toThrow(/between zero and 100/);
  });
});
