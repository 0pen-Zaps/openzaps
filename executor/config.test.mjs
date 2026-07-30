import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConversionPots,
  resolveCredentialFreeRpcUrls,
  resolveOptionalV3_2Config,
} from "./config.mjs";

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

test("ordinary RPC config accepts only canonical credential-free roots", () => {
  assert.deepEqual(
    resolveCredentialFreeRpcUrls({
      rpcUrls: "https://rpc-a.example,https://rpc-b.example:9443/",
      nodeEnv: "production",
    }),
    ["https://rpc-a.example", "https://rpc-b.example:9443"],
  );
  assert.deepEqual(
    resolveCredentialFreeRpcUrls({
      rpcUrl: "http://127.0.0.1:8545/",
      nodeEnv: "test",
    }),
    ["http://127.0.0.1:8545"],
  );
  assert.deepEqual(
    resolveCredentialFreeRpcUrls({
      rpcUrl: "http://[::1]:8545",
      nodeEnv: "development",
    }),
    ["http://[::1]:8545"],
  );
});

test("ordinary RPC config rejects credentials, paths, queries, fragments, and production HTTP", () => {
  for (const rpcUrl of [
    "https://user:password@rpc.example",
    "https://rpc.example/provider-key",
    "https://rpc.example/?apiKey=secret",
    "https://rpc.example/#secret",
    "http://127.0.0.1:8545",
    "http://rpc.example",
  ]) {
    assert.throws(
      () =>
        resolveCredentialFreeRpcUrls({
          rpcUrl,
          nodeEnv: "production",
        }),
      (error) =>
        /credential-free HTTPS origins/.test(error.message)
        && !error.message.includes("password")
        && !error.message.includes("provider-key")
        && !error.message.includes("apiKey=secret"),
    );
  }
});

test("ordinary RPC config rejects ambiguous and duplicate endpoint sources", () => {
  assert.throws(
    () =>
      resolveCredentialFreeRpcUrls({
        rpcUrl: "https://rpc-a.example",
        rpcUrls: ["https://rpc-b.example"],
      }),
    /use only one/,
  );
  assert.throws(
    () =>
      resolveCredentialFreeRpcUrls({
        rpcUrls: [
          "https://rpc-a.example",
          "https://rpc-a.example/",
        ],
      }),
    /distinct RPC origins/,
  );
});
