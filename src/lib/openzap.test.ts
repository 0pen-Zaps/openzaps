import { describe, expect, it } from "vitest";

import {
  MAX_EXECUTION_FEE_PER_GAS,
  MAX_EXECUTION_GAS,
  MAX_ROUTER_AMOUNT,
  assetsForDirection,
  buildRobinhoodPolicy,
  directionFromTokenIn,
  expectedCloneRuntime,
  hashRobinhoodPolicy,
  parseRouterAmount,
  randomHex32,
  randomNonce,
} from "@/lib/openzap";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  policyComponents,
  robinhoodPoolKey,
  stepComponents,
} from "@/lib/robinhood";

// Golden hashes computed with Foundry (`cast abi-encode` + `cast keccak`), the same
// encoder semantics as the deployed contract's `keccak256(abi.encode(p))` in
// contracts/src/OpenZap.sol. If the tuple component order ever drifts from the
// Solidity structs, these assertions fail.
const GOLDEN_BUY_OWNER = "0x1111111111111111111111111111111111111111" as const;
const GOLDEN_BUY_AMOUNT = 1_000_000_000_000_000n; // 0.001e18 aeWETH
const GOLDEN_BUY_HASH = "0x519a2dc08895f6a755f67bcc4882c00c08df46a9d95b8b3ae2b388602f7e0143";
const GOLDEN_SELL_OWNER = "0x2222222222222222222222222222222222222222" as const;
const GOLDEN_SELL_AMOUNT = 250_000_000_000_000_000_000n; // 250e18 0xZAPS
const GOLDEN_SELL_HASH = "0x5a44b2c97d7903271333858bde3658318fa443aabb3e3bed8456cf72c7b737e1";

describe("ABI component order matches contracts/src/libraries/OpenZapTypes.sol", () => {
  it("Step tuple order is adapter, tokenIn, spender, amountIn, data", () => {
    expect(stepComponents.map((c) => c.name)).toEqual(["adapter", "tokenIn", "spender", "amountIn", "data"]);
  });

  it("Policy tuple order is owner, recipient, maxRelayerFeeCap, optimization, trackedAssets, steps", () => {
    expect(policyComponents.map((c) => c.name)).toEqual([
      "owner",
      "recipient",
      "maxRelayerFeeCap",
      "optimization",
      "trackedAssets",
      "steps",
    ]);
  });
});

describe("hashRobinhoodPolicy parity with Foundry abi.encode", () => {
  it("matches the golden buy-direction hash", () => {
    const policy = buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", GOLDEN_BUY_AMOUNT);
    expect(hashRobinhoodPolicy(policy)).toBe(GOLDEN_BUY_HASH);
  });

  it("matches the golden sell-direction hash", () => {
    const policy = buildRobinhoodPolicy(GOLDEN_SELL_OWNER, "sell", GOLDEN_SELL_AMOUNT);
    expect(hashRobinhoodPolicy(policy)).toBe(GOLDEN_SELL_HASH);
  });
});

describe("buildRobinhoodPolicy", () => {
  it("binds owner as recipient with a zero relayer fee cap and one step", () => {
    const policy = buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", GOLDEN_BUY_AMOUNT);
    expect(policy.recipient).toBe(GOLDEN_BUY_OWNER);
    expect(policy.maxRelayerFeeCap).toBe(0n);
    expect(policy.optimization).toBe(true);
    expect(policy.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps]);
    expect(policy.steps).toHaveLength(1);
    expect(policy.steps[0].adapter).toBe(OPENZAP_CONTRACTS.adapter);
    expect(policy.steps[0].spender).toBe(OPENZAP_CONTRACTS.adapter);
    expect(policy.steps[0].data).toBe("0x");
  });

  it("selects the direction's input token", () => {
    expect(buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", 1n).steps[0].tokenIn).toBe(ROBINHOOD_ASSETS.weth);
    expect(buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "sell", 1n).steps[0].tokenIn).toBe(ROBINHOOD_ASSETS.zaps);
  });

  it("rejects amounts outside the router's uint128 range", () => {
    expect(() => buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", 0n)).toThrow();
    expect(() => buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", MAX_ROUTER_AMOUNT + 1n)).toThrow();
    expect(() => buildRobinhoodPolicy(GOLDEN_BUY_OWNER, "buy", MAX_ROUTER_AMOUNT)).not.toThrow();
  });
});

describe("parseRouterAmount", () => {
  it("parses plain and fractional decimal amounts at 18 decimals", () => {
    expect(parseRouterAmount("1")).toBe(10n ** 18n);
    expect(parseRouterAmount("0.001")).toBe(1_000_000_000_000_000n);
    expect(parseRouterAmount(" 2.5 ")).toBe(2_500_000_000_000_000_000n);
  });

  it("rejects malformed, negative, zero, and over-precise input", () => {
    for (const bad of ["", ".", "abc", "-1", "1.2.3", "1e18", "0", "0.0"]) {
      expect(() => parseRouterAmount(bad), bad).toThrow();
    }
    expect(() => parseRouterAmount("0." + "1".repeat(19))).toThrow(/18 decimal/);
  });

  it("enforces the uint128 router ceiling", () => {
    const max = MAX_ROUTER_AMOUNT; // 2^128 - 1 wei
    expect(() => parseRouterAmount("340282366920938463463.374607431768211455")).not.toThrow();
    expect(parseRouterAmount("340282366920938463463.374607431768211455")).toBe(max);
    expect(() => parseRouterAmount("340282366920938463463.374607431768211456")).toThrow(/uint128/);
  });

  // Per-token decimals are the #1 money trap: USDG is 6, ozUSDG is 9. A 6-dp
  // amount parsed at the default 18 would be 10^12x too large.
  it("parses at the token's real decimals when given", () => {
    expect(parseRouterAmount("1", 6)).toBe(1_000_000n); // 1 USDG
    expect(parseRouterAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseRouterAmount("0.000001", 6)).toBe(1n);
    expect(parseRouterAmount("1", 9)).toBe(1_000_000_000n); // 1 ozUSDG
    expect(parseRouterAmount("2.5", 9)).toBe(2_500_000_000n);
  });

  it("rejects more fractional places than the token has decimals", () => {
    expect(() => parseRouterAmount("1.0000001", 6)).toThrow(/6 decimal/);
    expect(() => parseRouterAmount("1.0000000001", 9)).toThrow(/9 decimal/);
    // A 6-dp value is fine at 18 dp; the default still behaves as before.
    expect(parseRouterAmount("1.0000001")).toBe(1_000_000_100_000_000_000n);
  });
});

describe("assetsForDirection and pool ordering", () => {
  it("keeps poolKey currency ordering (currency0 < currency1)", () => {
    expect(robinhoodPoolKey.currency0.toLowerCase() < robinhoodPoolKey.currency1.toLowerCase()).toBe(true);
    expect(robinhoodPoolKey.currency0).toBe(ROBINHOOD_ASSETS.weth);
    expect(robinhoodPoolKey.currency1).toBe(ROBINHOOD_ASSETS.zaps);
  });

  it("maps buy to zeroForOne (aeWETH -> 0xZAPS) and sell to the reverse", () => {
    const buy = assetsForDirection("buy");
    expect(buy.zeroForOne).toBe(true);
    expect(buy.tokenIn).toBe(ROBINHOOD_ASSETS.weth);
    expect(buy.tokenOut).toBe(ROBINHOOD_ASSETS.zaps);
    const sell = assetsForDirection("sell");
    expect(sell.zeroForOne).toBe(false);
    expect(sell.tokenIn).toBe(ROBINHOOD_ASSETS.zaps);
    expect(sell.tokenOut).toBe(ROBINHOOD_ASSETS.weth);
  });

  it("derives direction from a policy's input token, case-insensitively", () => {
    expect(directionFromTokenIn(ROBINHOOD_ASSETS.weth.toLowerCase() as `0x${string}`)).toBe("buy");
    expect(directionFromTokenIn(ROBINHOOD_ASSETS.zaps)).toBe("sell");
    expect(() => directionFromTokenIn("0x0000000000000000000000000000000000000001")).toThrow();
  });
});

describe("expectedCloneRuntime", () => {
  it("produces the EIP-1167 runtime for the deployed implementation", () => {
    expect(expectedCloneRuntime(OPENZAP_CONTRACTS.implementation)).toBe(
      "0x363d3d373d3d3d363d732a5eb455952d25b8060ee933d2badb022c7ae11a5af43d82803e903d91602b57fd5bf3",
    );
  });
});

describe("intent bounds and randomness", () => {
  it("caps execution gas and fee price to finite values (never maxUint256)", () => {
    expect(MAX_EXECUTION_GAS).toBe(3_000_000n);
    expect(MAX_EXECUTION_FEE_PER_GAS).toBe(10_000_000_000n);
  });

  it("randomHex32 returns 32-byte hex and randomNonce is non-deterministic", () => {
    expect(randomHex32()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});
