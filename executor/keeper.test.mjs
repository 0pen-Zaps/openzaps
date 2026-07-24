// Unit tests for the keeper's pure planning math. Run: node --test executor/keeper.test.mjs
// (The full on-chain buyZaps path is covered end-to-end in e2e-local.mjs against anvil.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPotConversion, gasHealth } from "./keeper.mjs";

const Q96 = 1n << 96n;
const ONE = 1_000_000_000_000_000_000n; // 1e18
const MIN = 1_000_000_000_000_000n; // 0.001e18

test("planPotConversion: skips an empty pot", () => {
  const plan = planPotConversion({ feeBalance: 0n, priceX96: 2n * Q96, minConvertWei: MIN, slippageBps: 300 });
  assert.equal(plan.convert, false);
});

test("planPotConversion: skips dust below the threshold", () => {
  const plan = planPotConversion({ feeBalance: MIN - 1n, priceX96: 2n * Q96, minConvertWei: MIN, slippageBps: 300 });
  assert.equal(plan.convert, false);
  assert.match(plan.reason, /below convert threshold/);
});

test("planPotConversion: skips when the price source is unreadable", () => {
  const plan = planPotConversion({ feeBalance: ONE, priceX96: 0n, minConvertWei: MIN, slippageBps: 300 });
  assert.equal(plan.convert, false);
});

test("planPotConversion: floors output by slippage at the pool spot", () => {
  // price = 2 0xZAPS per aeWETH → 1e18 aeWETH expects 2e18 0xZAPS; 3% slippage floor = 1.94e18.
  const plan = planPotConversion({ feeBalance: ONE, priceX96: 2n * Q96, minConvertWei: MIN, slippageBps: 300 });
  assert.equal(plan.convert, true);
  assert.equal(plan.amountIn, ONE);
  assert.equal(plan.expected, 2n * ONE);
  assert.equal(plan.minZapsOut, (2n * ONE * 9700n) / 10000n); // 1.94e18
});

test("planPotConversion: clamps garbage slippage instead of producing a negative floor", () => {
  const hi = planPotConversion({ feeBalance: ONE, priceX96: 2n * Q96, minConvertWei: MIN, slippageBps: 100000 });
  assert.equal(hi.convert, true);
  assert.ok(hi.minZapsOut > 0n); // clamped to 9999 bps, never below zero
  const lo = planPotConversion({ feeBalance: ONE, priceX96: 2n * Q96, minConvertWei: MIN, slippageBps: -50 });
  assert.equal(lo.minZapsOut, 2n * ONE); // 0 bps → full expected
});

test("gasHealth: unknown per-run cost is treated as OK", () => {
  assert.deepEqual(gasHealth({ balanceWei: 0n, perRunWei: 0n, warnRuns: 10 }), { level: "ok", runsLeft: Infinity });
});

test("gasHealth: empty when it cannot fund one run", () => {
  const h = gasHealth({ balanceWei: MIN, perRunWei: ONE, warnRuns: 10 });
  assert.equal(h.level, "empty");
});

test("gasHealth: low when under the warn-runs cushion", () => {
  const perRun = MIN; // cheap runs
  const h = gasHealth({ balanceWei: perRun * 5n, perRunWei: perRun, warnRuns: 10 });
  assert.equal(h.level, "low");
  assert.equal(h.runsLeft, 5);
});

test("gasHealth: ok with a comfortable cushion", () => {
  const perRun = MIN;
  const h = gasHealth({ balanceWei: perRun * 50n, perRunWei: perRun, warnRuns: 10 });
  assert.equal(h.level, "ok");
});
