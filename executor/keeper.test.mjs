// Unit tests for the keeper's pure planning math. Run: node --test executor/keeper.test.mjs
// (The full on-chain buyZaps path is covered end-to-end in e2e-local.mjs against anvil.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPotFees, planPotConversion, gasHealth } from "./keeper.mjs";

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

test("pot conversion obeys the shared pre-broadcast nonce-lane gate", async () => {
  let broadcasts = 0;
  const result = await convertPotFees({
    publicClient: {
      readContract: async ({ functionName }) => (functionName === "balanceOf" ? ONE : 2n * Q96),
      simulateContract: async () => ({ request: { address: "0x0000000000000000000000000000000000000001" } }),
    },
    walletClient: {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => {
        broadcasts += 1;
        return `0x${"12".repeat(32)}`;
      },
    },
    cfg: {
      lotteryPot: "0x0000000000000000000000000000000000000001",
      poolPriceSource: "0x0000000000000000000000000000000000000002",
      feeAsset: "0x0000000000000000000000000000000000000003",
      convertMinWei: MIN,
      convertSlippageBps: 300,
      maxFeePerGasWei: 2_000_000_000n,
    },
    canBroadcast: async () => ({
      allowed: false,
      outcome: "nonce-lane-pending",
      detail: "executor nonce lane has one unresolved transaction",
    }),
  });

  assert.equal(result.outcome, "nonce-lane-pending");
  assert.equal(broadcasts, 0);
});

test("pot conversion reports confirmation-pending after broadcast instead of broadcast-failed", async () => {
  const hash = `0x${"34".repeat(32)}`;
  const result = await convertPotFees({
    publicClient: {
      readContract: async ({ functionName }) => (functionName === "balanceOf" ? ONE : 2n * Q96),
      simulateContract: async () => ({ request: { address: "0x0000000000000000000000000000000000000001" } }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => {
        throw new Error("timeout");
      },
    },
    walletClient: {
      account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      writeContract: async () => hash,
    },
    cfg: {
      lotteryPot: "0x0000000000000000000000000000000000000001",
      poolPriceSource: "0x0000000000000000000000000000000000000002",
      feeAsset: "0x0000000000000000000000000000000000000003",
      convertMinWei: MIN,
      convertSlippageBps: 300,
      maxFeePerGasWei: 2_000_000_000n,
    },
  });

  assert.equal(result.outcome, "confirmation-pending");
  assert.equal(result.txHash, hash);
});

test("pot conversion fails closed when the pending base fee is unreadable or above its cap", async (t) => {
  for (const [name, getBlock, expected] of [
    ["unreadable", async () => { throw new Error("pending fee unavailable"); }, "fee-market-unknown"],
    ["above cap", async () => ({ baseFeePerGas: 2_000_000_001n }), "gas-above-cap"],
  ]) {
    await t.test(name, async () => {
      let broadcasts = 0;
      const result = await convertPotFees({
        publicClient: {
          readContract: async ({ functionName }) => (functionName === "balanceOf" ? ONE : 2n * Q96),
          simulateContract: async () => ({
            request: { address: "0x0000000000000000000000000000000000000001" },
          }),
          getBlock,
        },
        walletClient: {
          account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
          writeContract: async () => {
            broadcasts += 1;
            return `0x${"56".repeat(32)}`;
          },
        },
        cfg: {
          lotteryPot: "0x0000000000000000000000000000000000000001",
          poolPriceSource: "0x0000000000000000000000000000000000000002",
          feeAsset: "0x0000000000000000000000000000000000000003",
          convertMinWei: MIN,
          convertSlippageBps: 300,
          maxFeePerGasWei: 2_000_000_000n,
        },
      });

      assert.equal(result.outcome, expected);
      assert.equal(broadcasts, 0);
    });
  }
});
