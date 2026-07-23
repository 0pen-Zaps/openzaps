import { encodeAbiParameters, getAddress, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  buildRobinhoodPolicy,
  buildRoutePolicy,
  encodeStepData,
  hashRobinhoodPolicy,
} from "@/lib/openzap";
import {
  deployedRoutes,
  resolveOfferedRoutes,
  resolveRouteById,
  resolveRouteFromStep,
  stepDataFitsRoute,
  type Route,
} from "@/lib/routes";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  robinhoodPoolKey,
  usdgPoolKey,
} from "@/lib/robinhood";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ENCODED_ZERO = encodeAbiParameters([{ type: "uint256" }], [0n]);

function route(id: string): Route {
  const resolved = resolveRouteById(id);
  if (!resolved) throw new Error(`route ${id} did not resolve`);
  return resolved;
}

describe("resolveRoute — the deployed route set", () => {
  it("resolves all four swaps and both vault legs", () => {
    expect(deployedRoutes().map((r) => r.id)).toEqual([
      "robinhood-v4-weth-zaps",
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
      "robinhood-v4-usdg-weth",
      "robinhood-zap-vault-deposit",
      "robinhood-zap-vault-redeem",
    ]);
  });

  it("resolves the bounded aeWETH → 0xZAPS buy exactly as the original route", () => {
    const buy = route("robinhood-v4-weth-zaps");
    expect(buy.kind).toBe("swap");
    expect(buy.adapter).toBe(OPENZAP_CONTRACTS.adapter);
    expect(buy.spender).toBe(OPENZAP_CONTRACTS.adapter);
    expect(buy.tokenIn).toEqual({ symbol: "aeWETH", address: ROBINHOOD_ASSETS.weth, decimals: 18 });
    expect(buy.tokenOut).toEqual({ symbol: "0xZAPS", address: ROBINHOOD_ASSETS.zaps, decimals: 18 });
    expect(buy.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps]);
    expect(buy.data).toBe("empty");
    expect(buy.quote).toEqual({ source: "v4", poolKey: robinhoodPoolKey, zeroForOne: true });
    expect(buy.requiresSeededVault).toBe(false);
    expect(buy.direction).toBe("buy");
  });

  it("resolves the bounded sell with fixed [aeWETH, 0xZAPS] tracked order and zeroForOne false", () => {
    const sell = route("robinhood-v4-zaps-weth");
    expect(sell.tokenIn.address).toBe(ROBINHOOD_ASSETS.zaps);
    expect(sell.tokenOut.address).toBe(ROBINHOOD_ASSETS.weth);
    // Tracked assets are the pool's [currency0, currency1], NOT [tokenIn, tokenOut].
    expect(sell.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps]);
    expect(sell.quote).toEqual({ source: "v4", poolKey: robinhoodPoolKey, zeroForOne: false });
    expect(sell.direction).toBe("sell");
  });

  it("resolves the USDG pool buy with 6-decimal USDG out, min-amount-out data, and its own pool key", () => {
    const usdgBuy = route("robinhood-v4-weth-usdg");
    expect(usdgBuy.tokenIn.decimals).toBe(18);
    expect(usdgBuy.tokenOut).toEqual({ symbol: "USDG", address: ROBINHOOD_ASSETS.usdg, decimals: 6 });
    expect(usdgBuy.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg]);
    expect(usdgBuy.data).toBe("min-amount-out");
    expect(usdgBuy.quote).toEqual({ source: "v4", poolKey: usdgPoolKey, zeroForOne: true });
    // A USDG buy/sell is NOT the bounded pair — direction must be null so /app
    // never confuses it with the 0xZAPS route.
    expect(usdgBuy.direction).toBeNull();
    expect(usdgBuy.requiresSeededVault).toBe(false);
  });

  it("resolves the USDG pool sell with zeroForOne false (USDG is currency1)", () => {
    const usdgSell = route("robinhood-v4-usdg-weth");
    expect(usdgSell.tokenIn).toEqual({ symbol: "USDG", address: ROBINHOOD_ASSETS.usdg, decimals: 6 });
    expect(usdgSell.tokenOut.decimals).toBe(18);
    expect(usdgSell.quote).toEqual({ source: "v4", poolKey: usdgPoolKey, zeroForOne: false });
    expect(usdgSell.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg]);
  });

  it("resolves the vault deposit: USDG(6) → ozUSDG(9), empty data, previewDeposit, seed-gated", () => {
    const deposit = route("robinhood-zap-vault-deposit");
    expect(deposit.kind).toBe("vault-deposit");
    expect(deposit.tokenIn).toEqual({ symbol: "USDG", address: ROBINHOOD_ASSETS.usdg, decimals: 6 });
    expect(deposit.tokenOut).toEqual({ symbol: "ozUSDG", address: ROBINHOOD_ASSETS.ozusdg, decimals: 9 });
    expect(deposit.trackedAssets).toEqual([ROBINHOOD_ASSETS.usdg, ROBINHOOD_ASSETS.ozusdg]);
    expect(deposit.data).toBe("empty");
    expect(deposit.quote).toEqual({ source: "erc4626-deposit", vault: ROBINHOOD_ASSETS.ozusdg });
    expect(deposit.requiresSeededVault).toBe(true);
    expect(deposit.direction).toBeNull();
  });

  it("resolves the vault redeem: ozUSDG(9) → USDG(6), previewRedeem, same tracked pair as deposit", () => {
    const redeem = route("robinhood-zap-vault-redeem");
    expect(redeem.kind).toBe("vault-redeem");
    expect(redeem.tokenIn).toEqual({ symbol: "ozUSDG", address: ROBINHOOD_ASSETS.ozusdg, decimals: 9 });
    expect(redeem.tokenOut).toEqual({ symbol: "USDG", address: ROBINHOOD_ASSETS.usdg, decimals: 6 });
    // Deposit and redeem MUST commit the identical tracked-asset pair.
    expect(redeem.trackedAssets).toEqual([ROBINHOOD_ASSETS.usdg, ROBINHOOD_ASSETS.ozusdg]);
    expect(redeem.quote).toEqual({ source: "erc4626-redeem", vault: ROBINHOOD_ASSETS.ozusdg });
    expect(redeem.requiresSeededVault).toBe(true);
  });
});

describe("buildRoutePolicy — per-route policy construction", () => {
  const GOLDEN_BUY_AMOUNT = 1_000_000_000_000_000n;
  const GOLDEN_SELL_AMOUNT = 250_000_000_000_000_000_000n;

  it("REGRESSION: the bounded route is byte-identical to buildRobinhoodPolicy", () => {
    expect(buildRoutePolicy(OWNER, route("robinhood-v4-weth-zaps"), GOLDEN_BUY_AMOUNT)).toEqual(
      buildRobinhoodPolicy(OWNER, "buy", GOLDEN_BUY_AMOUNT),
    );
    expect(buildRoutePolicy(OWNER, route("robinhood-v4-zaps-weth"), GOLDEN_SELL_AMOUNT)).toEqual(
      buildRobinhoodPolicy(OWNER, "sell", GOLDEN_SELL_AMOUNT),
    );
    // And the hashes match the pinned golden values via buildRobinhoodPolicy.
    expect(hashRobinhoodPolicy(buildRoutePolicy(OWNER, route("robinhood-v4-weth-zaps"), GOLDEN_BUY_AMOUNT))).toBe(
      "0x519a2dc08895f6a755f67bcc4882c00c08df46a9d95b8b3ae2b388602f7e0143",
    );
  });

  it("emits abi.encode(minOut) data for the USDG pool route", () => {
    const usdg = route("robinhood-v4-weth-usdg");
    const zero = buildRoutePolicy(OWNER, usdg, 1_000_000_000_000_000_000n);
    expect(zero.trackedAssets).toEqual([ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg]);
    expect(zero.steps[0].adapter).toBe(usdg.adapter);
    expect(zero.steps[0].tokenIn).toBe(ROBINHOOD_ASSETS.weth);
    // Non-empty 32-byte word — distinct from the original route's 0x.
    expect(zero.steps[0].data).toBe(ENCODED_ZERO);
    expect(zero.steps[0].data).not.toBe("0x");

    const floored = buildRoutePolicy(OWNER, usdg, 1_000_000_000_000_000_000n, 5000n);
    expect(floored.steps[0].data).toBe(encodeAbiParameters([{ type: "uint256" }], [5000n]));
  });

  it("emits empty data for both vault legs, and pulls a 6-decimal USDG amount", () => {
    const deposit = route("robinhood-zap-vault-deposit");
    // 1000 USDG at 6 decimals = 1_000_000_000 raw.
    const policy = buildRoutePolicy(OWNER, deposit, 1_000_000_000n);
    expect(policy.steps[0].data).toBe("0x");
    expect(policy.steps[0].adapter).toBe(deposit.adapter);
    expect(policy.steps[0].tokenIn).toBe(ROBINHOOD_ASSETS.usdg);
    expect(policy.trackedAssets).toEqual([ROBINHOOD_ASSETS.usdg, ROBINHOOD_ASSETS.ozusdg]);
  });

  it("encodeStepData is 0x for empty routes and a uint256 word for min-amount-out routes", () => {
    expect(encodeStepData(route("robinhood-v4-weth-zaps"), 5n)).toBe("0x");
    expect(encodeStepData(route("robinhood-zap-vault-deposit"), 5n)).toBe("0x");
    expect(encodeStepData(route("robinhood-v4-weth-usdg"), 5n)).toBe(
      encodeAbiParameters([{ type: "uint256" }], [5n]),
    );
  });
});

describe("resolveRouteFromStep — verifying an existing capsule's route", () => {
  it("resolves the bounded buy from its onchain step", () => {
    const resolved = resolveRouteFromStep(
      OPENZAP_CONTRACTS.adapter,
      ROBINHOOD_ASSETS.weth,
      [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps],
      "0x",
    );
    expect(resolved?.id).toBe("robinhood-v4-weth-zaps");
  });

  it("keys on the adapter address, then tokenIn, to pick the side within the pair", () => {
    const usdgBuy = route("robinhood-v4-weth-usdg");
    const usdgSell = route("robinhood-v4-usdg-weth");
    // Same adapter address, different tokenIn — must resolve to different sides.
    expect(
      resolveRouteFromStep(usdgBuy.adapter, ROBINHOOD_ASSETS.weth, [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg], ENCODED_ZERO)?.id,
    ).toBe("robinhood-v4-weth-usdg");
    expect(
      resolveRouteFromStep(usdgSell.adapter, ROBINHOOD_ASSETS.usdg, [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg], ENCODED_ZERO)?.id,
    ).toBe("robinhood-v4-usdg-weth");
  });

  it("accepts empty OR 32-byte data for the USDG pool route, rejects other lengths", () => {
    const usdg = route("robinhood-v4-weth-usdg");
    const tracked = [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg] as const;
    expect(resolveRouteFromStep(usdg.adapter, ROBINHOOD_ASSETS.weth, tracked, "0x")).not.toBeNull();
    expect(resolveRouteFromStep(usdg.adapter, ROBINHOOD_ASSETS.weth, tracked, ENCODED_ZERO)).not.toBeNull();
    expect(resolveRouteFromStep(usdg.adapter, ROBINHOOD_ASSETS.weth, tracked, `${ENCODED_ZERO}00` as `0x${string}`)).toBeNull();
  });

  it("rejects non-empty data for the original route (its adapter reverts on any data)", () => {
    expect(
      resolveRouteFromStep(OPENZAP_CONTRACTS.adapter, ROBINHOOD_ASSETS.weth, [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps], ENCODED_ZERO),
    ).toBeNull();
  });

  it("rejects an unknown adapter and a mismatched tracked-asset pair", () => {
    const stranger = getAddress("0x9999999999999999999999999999999999999999");
    expect(resolveRouteFromStep(stranger, ROBINHOOD_ASSETS.weth, [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps], "0x")).toBeNull();
    // Right adapter, wrong tracked pair.
    expect(
      resolveRouteFromStep(OPENZAP_CONTRACTS.adapter, ROBINHOOD_ASSETS.weth, [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.usdg], "0x"),
    ).toBeNull();
  });

  it("stepDataFitsRoute is case-insensitive on the 0x word", () => {
    expect(stepDataFitsRoute(route("robinhood-v4-weth-zaps"), "0x")).toBe(true);
    expect(stepDataFitsRoute(route("robinhood-v4-weth-usdg"), ENCODED_ZERO.toUpperCase() as `0x${string}`)).toBe(true);
  });
});

describe("resolveOfferedRoutes — fail-closed vault seeding gate", () => {
  function fakeClient(totalSupply: bigint | Error): PublicClient {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName !== "totalSupply") throw new Error(`unexpected call ${functionName}`);
        if (totalSupply instanceof Error) throw totalSupply;
        return totalSupply;
      },
    } as unknown as PublicClient;
  }

  it("excludes BOTH vault routes while the vault is unseeded (totalSupply 0)", async () => {
    const offered = await resolveOfferedRoutes(fakeClient(0n));
    const ids = offered.map((r) => r.id);
    expect(ids).toEqual([
      "robinhood-v4-weth-zaps",
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
      "robinhood-v4-usdg-weth",
    ]);
    expect(ids).not.toContain("robinhood-zap-vault-deposit");
    expect(ids).not.toContain("robinhood-zap-vault-redeem");
  });

  it("offers the vault routes once the vault is seeded (totalSupply > 0)", async () => {
    const ids = (await resolveOfferedRoutes(fakeClient(1_000n))).map((r) => r.id);
    expect(ids).toContain("robinhood-zap-vault-deposit");
    expect(ids).toContain("robinhood-zap-vault-redeem");
  });

  it("fails closed when the seeding read reverts — the vault route is not offered", async () => {
    const ids = (await resolveOfferedRoutes(fakeClient(new Error("rpc down")))).map((r) => r.id);
    expect(ids).not.toContain("robinhood-zap-vault-deposit");
    // Swaps need no read and are still offered.
    expect(ids).toContain("robinhood-v4-weth-zaps");
  });
});
