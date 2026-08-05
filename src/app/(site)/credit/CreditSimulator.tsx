"use client";

import { useMemo, useState } from "react";

import {
  CREDIT_STRESS_SHOCKS,
  DEFAULT_CREDIT_INPUTS,
  liquidationShockPct,
  simulateCredit,
  type CreditInputs,
  type CreditStrategy,
} from "./credit-model";
import styles from "./credit.module.css";

type NumericInputKey = keyof CreditInputs;

type RangeControlProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
  hint?: string;
};

function RangeControl({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  hint,
}: RangeControlProps): React.JSX.Element {
  return (
    <label className={styles.rangeControl} htmlFor={id}>
      <span className={styles.rangeLabel}>
        <span>{label}</span>
        <output htmlFor={id}>{display}</output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const DECIMAL_CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(value: number): string {
  return CURRENCY.format(value);
}

function signedMoney(value: number): string {
  if (Math.abs(value) < 0.005) return DECIMAL_CURRENCY.format(0);
  return `${value > 0 ? "+" : "−"}${DECIMAL_CURRENCY.format(Math.abs(value))}`;
}

function percent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "∞";
  return `${value.toFixed(digits)}%`;
}

function signedPercent(value: number, digits = 1): string {
  if (Math.abs(value) < 0.005) return "0.0%";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}

function strategyLabel(strategy: CreditStrategy): string {
  return strategy === "buy-zaps" ? "Buy + lock" : "Locked LP";
}

export function CreditSimulator(): React.JSX.Element {
  const [inputs, setInputs] = useState<CreditInputs>(DEFAULT_CREDIT_INPUTS);
  const [strategy, setStrategy] = useState<CreditStrategy>("agent-lp");
  const [zapsShockPct, setZapsShockPct] = useState(-40);

  const update = (key: NumericInputKey, value: number): void => {
    setInputs((current) => {
      const next = { ...current, [key]: value };
      if (key === "collateralUsd" && next.borrowUsd > value) next.borrowUsd = value;
      if (key === "borrowLtvPct" && next.liquidationLtvPct <= value) {
        next.liquidationLtvPct = Math.min(70, value + 1);
      }
      if (key === "liquidationLtvPct" && next.borrowLtvPct >= value) {
        next.borrowLtvPct = Math.max(1, value - 1);
      }
      return next;
    });
  };

  const active = useMemo(
    () => simulateCredit({ ...inputs, strategy, zapsShockPct }),
    [inputs, strategy, zapsShockPct],
  );
  const comparison = useMemo(
    () =>
      (["agent-lp", "buy-zaps"] as const).map((mode) => ({
        mode,
        result: simulateCredit({ ...inputs, strategy: mode, zapsShockPct }),
        liquidationShock: liquidationShockPct(inputs, mode),
      })),
    [inputs, zapsShockPct],
  );
  const scenarios = useMemo(
    () =>
      CREDIT_STRESS_SHOCKS.map((shock) => ({
        shock,
        buy: simulateCredit({ ...inputs, strategy: "buy-zaps", zapsShockPct: shock }),
        lp: simulateCredit({ ...inputs, strategy: "agent-lp", zapsShockPct: shock }),
      })),
    [inputs],
  );

  const state = !active.withinBorrowLimit
    ? "over-cap"
    : active.liquidatable
      ? "liquidation"
      : "healthy";
  const stateLabel =
    state === "over-cap" ? "Above origination cap" : state === "liquidation" ? "Liquidatable" : "Healthy in model";

  return (
    <div className={styles.simulator}>
      <header className={styles.simulatorHead}>
        <div>
          <span className={styles.kicker}>Deterministic design simulator</span>
          <h3>Stress one purpose-bound credit position.</h3>
          <p>
            Change collateral, debt, rates, peg, and exit conditions. The model keeps all borrowed USDG inside the
            policy account and gives financed assets zero new borrowing power.
          </p>
        </div>
        <div className={styles.modelStatus} data-state={state} aria-live="polite">
          <span aria-hidden />
          {stateLabel}
        </div>
      </header>

      <div className={styles.strategyTabs} aria-label="Credit strategy">
        {(["agent-lp", "buy-zaps"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={strategy === mode}
            onClick={() => setStrategy(mode)}
          >
            <span>{mode === "agent-lp" ? "Fee-producing" : "Reflexive exposure"}</span>
            <strong>{strategyLabel(mode)}</strong>
          </button>
        ))}
      </div>

      <div className={styles.simulatorGrid}>
        <div className={styles.controls}>
          <section className={styles.controlGroup}>
            <header>
              <span>01</span>
              <h4>Position</h4>
            </header>
            <RangeControl
              id="credit-collateral"
              label="Externally supplied 0xZAPS"
              value={inputs.collateralUsd}
              min={1_000}
              max={100_000}
              step={1_000}
              display={money(inputs.collateralUsd)}
              onChange={(value) => update("collateralUsd", value)}
              hint="Only this amount creates origination power."
            />
            <RangeControl
              id="credit-borrow"
              label="USDG borrowed"
              value={inputs.borrowUsd}
              min={0}
              max={inputs.collateralUsd}
              step={250}
              display={`${inputs.borrowUsd.toLocaleString("en-US")} USDG`}
              onChange={(value) => update("borrowUsd", value)}
              hint={`Pilot limit at current settings: ${money(active.borrowLimitUsd)}.`}
            />
            <RangeControl
              id="credit-days"
              label="Time outstanding"
              value={inputs.days}
              min={1}
              max={365}
              step={1}
              display={`${inputs.days} days`}
              onChange={(value) => update("days", value)}
            />
            <RangeControl
              id="credit-shock"
              label="0xZAPS terminal move"
              value={zapsShockPct}
              min={-90}
              max={50}
              step={5}
              display={signedPercent(zapsShockPct, 0)}
              onChange={setZapsShockPct}
            />
          </section>

          <section className={styles.controlGroup}>
            <header>
              <span>02</span>
              <h4>Risk policy</h4>
            </header>
            <RangeControl
              id="credit-borrow-ltv"
              label="Borrow LTV"
              value={inputs.borrowLtvPct}
              min={5}
              max={inputs.liquidationLtvPct - 1}
              step={1}
              display={percent(inputs.borrowLtvPct, 0)}
              onChange={(value) => update("borrowLtvPct", value)}
            />
            <RangeControl
              id="credit-liquidation-ltv"
              label="Liquidation LTV"
              value={inputs.liquidationLtvPct}
              min={inputs.borrowLtvPct + 1}
              max={70}
              step={1}
              display={percent(inputs.liquidationLtvPct, 0)}
              onChange={(value) => update("liquidationLtvPct", value)}
            />
            <RangeControl
              id="credit-oracle-haircut"
              label="Oracle / collateral haircut"
              value={inputs.oracleHaircutPct}
              min={0}
              max={50}
              step={1}
              display={percent(inputs.oracleHaircutPct, 0)}
              onChange={(value) => update("oracleHaircutPct", value)}
            />
            <RangeControl
              id="credit-liquidity-discount"
              label="Liquidation execution loss"
              value={inputs.liquidityDiscountPct}
              min={0}
              max={60}
              step={1}
              display={percent(inputs.liquidityDiscountPct, 0)}
              onChange={(value) => update("liquidityDiscountPct", value)}
              hint="Simplifies bonus, gas, slippage, and thin exit depth into one stress."
            />
          </section>

          <section className={styles.controlGroup}>
            <header>
              <span>03</span>
              <h4>Carry + peg</h4>
            </header>
            <RangeControl
              id="credit-borrow-apr"
              label="Borrow APR"
              value={inputs.borrowAprPct}
              min={0}
              max={50}
              step={1}
              display={percent(inputs.borrowAprPct, 0)}
              onChange={(value) => update("borrowAprPct", value)}
            />
            <RangeControl
              id="credit-fee-apr"
              label="Assumed net LP fee APR"
              value={inputs.lpFeeAprPct}
              min={0}
              max={100}
              step={1}
              display={percent(inputs.lpFeeAprPct, 0)}
              onChange={(value) => update("lpFeeAprPct", value)}
              hint="An assumption, not an advertised or observed yield."
            />
            <RangeControl
              id="credit-execution-cost"
              label="Entry cost"
              value={inputs.executionCostPct}
              min={0}
              max={5}
              step={0.25}
              display={percent(inputs.executionCostPct, 2)}
              onChange={(value) => update("executionCostPct", value)}
            />
            <RangeControl
              id="credit-stable-price"
              label="USDG terminal price"
              value={inputs.stablePriceUsd}
              min={0.85}
              max={1.05}
              step={0.01}
              display={DECIMAL_CURRENCY.format(inputs.stablePriceUsd)}
              onChange={(value) => update("stablePriceUsd", value)}
            />
          </section>
        </div>

        <div className={styles.results}>
          <div className={styles.headlineMetrics}>
            <article>
              <span>Health factor</span>
              <strong>{Number.isFinite(active.healthFactor) ? active.healthFactor.toFixed(2) : "∞"}</strong>
              <small>Below 1.00 triggers liquidation</small>
            </article>
            <article>
              <span>Net equity</span>
              <strong>{money(active.netEquityUsd)}</strong>
              <small>{signedMoney(active.excessVsUnleveredUsd)} vs holding 0xZAPS</small>
            </article>
            <article>
              <span>Estimated bad debt</span>
              <strong>{money(active.badDebtUsd)}</strong>
              <small>After the selected execution loss</small>
            </article>
            <article>
              <span>Withdrawable borrowed USDG</span>
              <strong>0</strong>
              <small>Policy account only</small>
            </article>
          </div>

          <section className={styles.comparisonBlock}>
            <header>
              <div>
                <span className={styles.kicker}>Same inputs, two uses</span>
                <h4>Strategy comparison</h4>
              </div>
              <p>
                The LP row uses a full-range 50/50 constant-product approximation. Concentrated liquidity requires a
                separate range-path simulation.
              </p>
            </header>
            <div className={styles.comparisonCards}>
              {comparison.map(({ mode, result, liquidationShock }) => (
                <article key={mode} data-active={strategy === mode || undefined}>
                  <span>{strategyLabel(mode)}</span>
                  <strong>{money(result.netEquityUsd)} equity</strong>
                  <dl>
                    <div>
                      <dt>Health</dt>
                      <dd>{Number.isFinite(result.healthFactor) ? result.healthFactor.toFixed(2) : "∞"}</dd>
                    </div>
                    <div>
                      <dt>Liquidation trigger</dt>
                      <dd>{liquidationShock === null ? "outside model" : signedPercent(liquidationShock)}</dd>
                    </div>
                    <div>
                      <dt>Interest</dt>
                      <dd>{money(result.financingCostUsd)}</dd>
                    </div>
                    <div>
                      <dt>{mode === "agent-lp" ? "Fee income" : "LP fee income"}</dt>
                      <dd>{money(result.lpFeeIncomeUsd)}</dd>
                    </div>
                    <div>
                      <dt>Impermanent loss</dt>
                      <dd>{mode === "agent-lp" ? signedPercent(result.impermanentLossPct) : "n/a"}</dd>
                    </div>
                    <div>
                      <dt>Risk LTV</dt>
                      <dd>{percent(result.riskAdjustedLtvPct)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.stressBlock}>
            <header>
              <div>
                <span className={styles.kicker}>Fixed shock sweep</span>
                <h4>0xZAPS downside table</h4>
              </div>
              <span>Liquidation state shown in red</span>
            </header>
            <div className={styles.tableWrap}>
              <table>
                <caption className="srOnly">
                  Buy-and-lock and locked-liquidity health factors across 0xZAPS price shocks
                </caption>
                <thead>
                  <tr>
                    <th scope="col">0xZAPS move</th>
                    <th scope="col">Buy health</th>
                    <th scope="col">Buy bad debt</th>
                    <th scope="col">LP health</th>
                    <th scope="col">LP bad debt</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map(({ shock, buy, lp }) => (
                    <tr key={shock}>
                      <th scope="row">{signedPercent(shock, 0)}</th>
                      <td data-danger={buy.liquidatable || undefined}>
                        {Number.isFinite(buy.healthFactor) ? buy.healthFactor.toFixed(2) : "∞"}
                      </td>
                      <td>{money(buy.badDebtUsd)}</td>
                      <td data-danger={lp.liquidatable || undefined}>
                        {Number.isFinite(lp.healthFactor) ? lp.healthFactor.toFixed(2) : "∞"}
                      </td>
                      <td>{money(lp.badDebtUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <footer className={styles.simulatorNote}>
        <strong>Model boundary.</strong>
        <span>
          This is reproducible design math, not a live quote or forecast. It uses simple interest, one terminal price
          shock, an assumed fee APR, and a full-range LP approximation. It does not model intraperiod liquidations,
          concentrated ranges, path-dependent fees, MEV, gas, correlated agents, oracle lag, or actual 0xZAPS depth.
          Those belong in the fork and Monte Carlo gates before any credit deployment.
        </span>
      </footer>
    </div>
  );
}
