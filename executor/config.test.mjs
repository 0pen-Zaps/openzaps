import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversionPots, resolveOptionalV3_2Config } from "./config.mjs";

const FACTORY = "0x0000000000000000000000000000000000000001";
const IMPLEMENTATION = "0x0000000000000000000000000000000000000002";
const POT = "0x0000000000000000000000000000000000000003";
const PRICE_SOURCE = "0x0000000000000000000000000000000000000004";
const FEE_ASSET = "0x0000000000000000000000000000000000000005";
const ZERO = "0x0000000000000000000000000000000000000000";

const complete = {
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  lotteryPot: POT,
  poolPriceSource: PRICE_SOURCE,
  feeAsset: FEE_ASSET,
};

test("optional v3.2 executor + conversion config is absent when every address is unset or zero", () => {
  assert.equal(resolveOptionalV3_2Config(), null);
  assert.equal(
    resolveOptionalV3_2Config({
      factory: ZERO,
      implementation: ZERO,
      lotteryPot: ZERO,
      poolPriceSource: ZERO,
      feeAsset: ZERO,
    }),
    null,
  );
});

test("optional v3.2 config rejects every partial activation, including tuning without addresses", () => {
  assert.throws(
    () => resolveOptionalV3_2Config({ factory: FACTORY, implementation: IMPLEMENTATION }),
    /configured all-or-none.*LOTTERY_POT.*POOL_PRICE_SOURCE.*FEE_ASSET/,
  );
  assert.throws(
    () => resolveOptionalV3_2Config({ ...complete, lotteryPot: ZERO }),
    /configured all-or-none.*LOTTERY_POT/,
  );
  assert.throws(
    () => resolveOptionalV3_2Config({ convertMinWei: "1" }),
    /configured all-or-none.*V3_2_FACTORY/,
  );
});

test("optional v3.2 config rejects malformed addresses and unsafe conversion bounds", () => {
  assert.throws(
    () => resolveOptionalV3_2Config({ ...complete, feeAsset: "not-an-address" }),
    /OPENZAPS_V3_2_FEE_ASSET must be an EVM address/,
  );
  assert.throws(
    () => resolveOptionalV3_2Config({ ...complete, convertMinWei: "0" }),
    /CONVERT_MIN_WEI must be greater than zero/,
  );
  assert.throws(
    () => resolveOptionalV3_2Config({ ...complete, convertSlippageBps: "10000" }),
    /CONVERT_SLIPPAGE_BPS must be an integer from 0 to 9999/,
  );
});

test("complete v3.2 config yields one identified pot with independent conversion tuning", () => {
  const resolved = resolveOptionalV3_2Config(
    {
      ...complete,
      convertMinWei: "42",
      convertSlippageBps: "125",
    },
    {
      fallbackConvertMinWei: 7n,
      fallbackConvertSlippageBps: 300,
    },
  );
  assert.deepEqual(resolved, {
    lineage: {
      factory: FACTORY,
      implementation: IMPLEMENTATION,
    },
    conversionPot: {
      id: "v3.2",
      lotteryPot: POT,
      poolPriceSource: PRICE_SOURCE,
      feeAsset: FEE_ASSET,
      convertMinWei: 42n,
      convertSlippageBps: 125,
    },
  });

  const inherited = resolveOptionalV3_2Config(complete, {
    fallbackConvertMinWei: 7n,
    fallbackConvertSlippageBps: 250,
  });
  assert.equal(inherited.conversionPot.convertMinWei, 7n);
  assert.equal(inherited.conversionPot.convertSlippageBps, 250);
});

test("v3.1 and v3.2 conversion targets cannot alias the same one-shot-bound pot", () => {
  const v3_1 = {
    id: "v3.1",
    lotteryPot: POT,
    poolPriceSource: PRICE_SOURCE,
    feeAsset: FEE_ASSET,
    convertMinWei: 1n,
    convertSlippageBps: 300,
  };
  assert.throws(
    () => buildConversionPots(v3_1, { ...v3_1, id: "v3.2", lotteryPot: POT.toUpperCase() }),
    /v3\.2 must use its own execution-fee lottery pot/,
  );
  assert.deepEqual(buildConversionPots(v3_1), [v3_1]);
});
