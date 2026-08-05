export type CreditStrategy = "buy-zaps" | "agent-lp";

export type CreditInputs = {
  collateralUsd: number;
  borrowUsd: number;
  days: number;
  borrowAprPct: number;
  lpFeeAprPct: number;
  executionCostPct: number;
  oracleHaircutPct: number;
  borrowLtvPct: number;
  liquidationLtvPct: number;
  liquidityDiscountPct: number;
  stablePriceUsd: number;
};

export type CreditScenario = CreditInputs & {
  strategy: CreditStrategy;
  zapsShockPct: number;
};

export type CreditSimulation = {
  strategy: CreditStrategy;
  priceRatio: number;
  borrowedStableUnits: number;
  withdrawableBorrowedStableUnits: 0;
  borrowLimitUsd: number;
  withinBorrowLimit: boolean;
  debtUsd: number;
  markCollateralUsd: number;
  riskAdjustedCollateralUsd: number;
  riskAdjustedLtvPct: number;
  healthFactor: number;
  liquidatable: boolean;
  liquidationRecoveryUsd: number;
  badDebtUsd: number;
  netEquityUsd: number;
  unleveredEquityUsd: number;
  excessVsUnleveredUsd: number;
  financingCostUsd: number;
  lpFeeIncomeUsd: number;
  impermanentLossPct: number;
};

export const DEFAULT_CREDIT_INPUTS: CreditInputs = {
  collateralUsd: 10_000,
  borrowUsd: 2_000,
  days: 90,
  borrowAprPct: 12,
  lpFeeAprPct: 18,
  executionCostPct: 0.75,
  oracleHaircutPct: 15,
  borrowLtvPct: 20,
  liquidationLtvPct: 35,
  liquidityDiscountPct: 15,
  stablePriceUsd: 1,
};

export const CREDIT_STRESS_SHOCKS = [-80, -60, -40, -20, 0, 25] as const;

const PERCENT = 100;
const YEAR_DAYS = 365;

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function validateCreditInputs(inputs: CreditInputs): void {
  for (const key of [
    "collateralUsd",
    "borrowUsd",
    "days",
    "borrowAprPct",
    "lpFeeAprPct",
    "executionCostPct",
    "oracleHaircutPct",
    "borrowLtvPct",
    "liquidationLtvPct",
    "liquidityDiscountPct",
    "stablePriceUsd",
  ] as const) {
    assertFinite(key, inputs[key]);
  }

  if (inputs.collateralUsd <= 0) throw new RangeError("collateralUsd must be greater than zero");
  if (inputs.borrowUsd < 0) throw new RangeError("borrowUsd cannot be negative");
  if (inputs.borrowUsd > inputs.collateralUsd) {
    throw new RangeError("borrowUsd cannot exceed deposited collateral value in this model");
  }
  if (inputs.days < 0) throw new RangeError("days cannot be negative");
  if (inputs.stablePriceUsd <= 0) throw new RangeError("stablePriceUsd must be greater than zero");

  for (const key of [
    "borrowAprPct",
    "lpFeeAprPct",
    "executionCostPct",
    "oracleHaircutPct",
    "borrowLtvPct",
    "liquidationLtvPct",
    "liquidityDiscountPct",
  ] as const) {
    if (inputs[key] < 0 || inputs[key] >= PERCENT) {
      throw new RangeError(`${key} must be between zero and 100`);
    }
  }

  if (inputs.borrowLtvPct >= inputs.liquidationLtvPct) {
    throw new RangeError("borrowLtvPct must be below liquidationLtvPct");
  }
}

/**
 * Deterministic design model for a single isolated position.
 *
 * It deliberately gives financed assets no origination power: `borrowLimitUsd`
 * depends only on the user's deposited 0xZAPS. Financed 0xZAPS or LP assets
 * remain locked and may help liquidation recovery, but cannot be borrowed
 * against again.
 */
export function simulateCredit(scenario: CreditScenario): CreditSimulation {
  validateCreditInputs(scenario);
  assertFinite("zapsShockPct", scenario.zapsShockPct);
  if (scenario.zapsShockPct <= -100) throw new RangeError("zapsShockPct must be greater than -100");

  const priceRatio = 1 + scenario.zapsShockPct / PERCENT;
  const borrowApr = scenario.borrowAprPct / PERCENT;
  const feeApr = scenario.lpFeeAprPct / PERCENT;
  const executionRetention = 1 - scenario.executionCostPct / PERCENT;
  const oracleRetention = 1 - scenario.oracleHaircutPct / PERCENT;
  const liquidationRetention = 1 - scenario.liquidityDiscountPct / PERCENT;
  const liquidationLtv = scenario.liquidationLtvPct / PERCENT;
  const borrowLimitUsd = scenario.collateralUsd * (scenario.borrowLtvPct / PERCENT);
  const interestUnits = scenario.borrowUsd * borrowApr * (scenario.days / YEAR_DAYS);
  const debtUsd = (scenario.borrowUsd + interestUnits) * scenario.stablePriceUsd;
  const financingCostUsd = interestUnits * scenario.stablePriceUsd;
  const deployedStableUnits = scenario.borrowUsd * executionRetention;

  let markCollateralUsd: number;
  let lpFeeIncomeUsd = 0;
  let impermanentLossPct = 0;

  if (scenario.strategy === "buy-zaps") {
    const financedZapsEntryValue = deployedStableUnits;
    markCollateralUsd = (scenario.collateralUsd + financedZapsEntryValue) * priceRatio;
  } else {
    const pairedZapsEntryValue = deployedStableUnits;
    const unpairedZapsEntryValue = Math.max(0, scenario.collateralUsd - pairedZapsEntryValue);
    const lpPrincipalUsd =
      2 * deployedStableUnits * Math.sqrt(priceRatio * scenario.stablePriceUsd);
    lpFeeIncomeUsd = 2 * deployedStableUnits * feeApr * (scenario.days / YEAR_DAYS);
    markCollateralUsd = unpairedZapsEntryValue * priceRatio + lpPrincipalUsd + lpFeeIncomeUsd;

    const holdPairValueUsd = deployedStableUnits * (priceRatio + scenario.stablePriceUsd);
    impermanentLossPct =
      holdPairValueUsd === 0 ? 0 : ((lpPrincipalUsd / holdPairValueUsd) - 1) * PERCENT;
  }

  const riskAdjustedCollateralUsd = markCollateralUsd * oracleRetention;
  const riskAdjustedLtvPct =
    riskAdjustedCollateralUsd === 0
      ? Number.POSITIVE_INFINITY
      : (debtUsd / riskAdjustedCollateralUsd) * PERCENT;
  const healthFactor =
    debtUsd === 0 ? Number.POSITIVE_INFINITY : (riskAdjustedCollateralUsd * liquidationLtv) / debtUsd;
  const liquidatable = healthFactor < 1;
  const liquidationRecoveryUsd = markCollateralUsd * liquidationRetention;
  const badDebtUsd = Math.max(0, debtUsd - liquidationRecoveryUsd);
  const netEquityUsd = markCollateralUsd - debtUsd;
  const unleveredEquityUsd = scenario.collateralUsd * priceRatio;

  return {
    strategy: scenario.strategy,
    priceRatio,
    borrowedStableUnits: scenario.borrowUsd,
    withdrawableBorrowedStableUnits: 0,
    borrowLimitUsd,
    withinBorrowLimit: scenario.borrowUsd <= borrowLimitUsd,
    debtUsd,
    markCollateralUsd,
    riskAdjustedCollateralUsd,
    riskAdjustedLtvPct,
    healthFactor,
    liquidatable,
    liquidationRecoveryUsd,
    badDebtUsd,
    netEquityUsd,
    unleveredEquityUsd,
    excessVsUnleveredUsd: netEquityUsd - unleveredEquityUsd,
    financingCostUsd,
    lpFeeIncomeUsd,
    impermanentLossPct,
  };
}

export function liquidationShockPct(
  inputs: CreditInputs,
  strategy: CreditStrategy,
): number | null {
  validateCreditInputs(inputs);
  if (inputs.borrowUsd === 0) return null;

  const healthAt = (ratio: number): number =>
    simulateCredit({ ...inputs, strategy, zapsShockPct: (ratio - 1) * PERCENT }).healthFactor;

  let low = 0.000_001;
  let high = 3;
  if (healthAt(low) >= 1 || healthAt(high) < 1) return null;

  for (let iteration = 0; iteration < 96; iteration += 1) {
    const middle = (low + high) / 2;
    if (healthAt(middle) < 1) low = middle;
    else high = middle;
  }

  return (((low + high) / 2) - 1) * PERCENT;
}

export function recursiveExposureMultiple(ltvPct: number): number {
  assertFinite("ltvPct", ltvPct);
  if (ltvPct < 0 || ltvPct >= PERCENT) throw new RangeError("ltvPct must be between zero and 100");
  return 1 / (1 - ltvPct / PERCENT);
}
