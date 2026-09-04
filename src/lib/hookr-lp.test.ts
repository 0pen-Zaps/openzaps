import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress, zeroAddress } from "viem";

import { makeNode, type ChainNode, type ParamValue } from "@/lib/blocks";

/**
 * The Hookr liquidity slice at the app layer: per-pool routes generated from
 * the pool table, the two hooked step-data shapes, and the four blueprints
 * (zap in, aeWETH → pool, zap out, migrate).
 *
 * Both deployment states run here, because fail-closed IS the claim: until
 * `DeployRobinhoodHookrLiquidity.s.sol` has broadcast and its three addresses
 * plus each pool's vault are configured, no surface may offer a Hookr LP route;
 * the moment they are, every surface lights up without a code change. The
 * onchain half is proven by `contracts/test/HookedRangeLiquidity.fork.t.sol`
 * against the live pools and the live v1.1 factory.
 */

const HOOKR = getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c");
const HOOKR_HOOK = getAddress("0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC");
const KRN = getAddress("0xBb371991468BD17d007a3Da6B400e6eD0CCd8807");
// Pool ids read off the live PoolManager's Initialize history (2026-09-04).
const KRN_POOL_ID = "0xe9901bceb8c2251ceb3d9f61c795f8d68ef95f86fb61163427db341075dbaf80";
const TCL_POOL_ID = "0x9a3b77a63344c7a100ccccf4cf6da281ba6020160cbc2b9179085d1bbcb2e525";

const FACTORY = getAddress("0x1111111111111111111111111111111111111111");
const DEPOSIT = getAddress("0x2222222222222222222222222222222222222222");
const WITHDRAW = getAddress("0x3333333333333333333333333333333333333333");
const VAULT_KRN = getAddress("0x5555555555555555555555555555555555555555");
const VAULT_TCL = getAddress("0x6666666666666666666666666666666666666666");
const HOOKR_SWAP_ADAPTER = getAddress("0x7777777777777777777777777777777777777777");

const DEPOSIT_KRN = "hookr-lp-deposit-krn";
const WITHDRAW_KRN = "hookr-lp-withdraw-krn";
const DEPOSIT_TCL = "hookr-lp-deposit-tcl";
const DEPOSIT_CANV5H = "hookr-lp-deposit-canv5h";

function stubContracts(): void {
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_FACTORY", FACTORY);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER", DEPOSIT);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_WITHDRAW_ADAPTER", WITHDRAW);
}

function stubVaults(): void {
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS", JSON.stringify({ krn: VAULT_KRN, tcl: VAULT_TCL }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function recipeChain(id: string): Promise<ChainNode[]> {
  const { RECIPES } = await import("@/lib/blocks");
  const recipe = RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error(`recipe ${id} is not in the catalog`);
  return recipe.blocks.map(([blockId, params], index) =>
    makeNode(blockId, `${id}-${index}`, params as Record<string, ParamValue> | undefined),
  );
}

describe("Hookr LP pool table", () => {
  it("derives each pool's key and id exactly as v4-core does, with the Hookr hook pinned", async () => {
    const { hookrLpPools, hookrLpPoolId, HOOKR_LP_DYNAMIC_FEE, HOOKR_LP_TICK_SPACING } = await import("@/lib/hookr-pools");
    const krn = hookrLpPools().find((pool) => pool.key === "krn");
    const tcl = hookrLpPools().find((pool) => pool.key === "tcl");
    expect(krn?.poolId).toBe(KRN_POOL_ID);
    expect(tcl?.poolId).toBe(TCL_POOL_ID);
    expect(hookrLpPoolId(KRN)).toBe(KRN_POOL_ID);
    expect(krn?.poolKey).toEqual({
      currency0: HOOKR,
      currency1: KRN,
      fee: HOOKR_LP_DYNAMIC_FEE,
      tickSpacing: HOOKR_LP_TICK_SPACING,
      hooks: HOOKR_HOOK,
    });
    expect(krn?.poolLabel).toBe("HOOKR/KRN");
    expect(krn?.shareSymbol).toBe("ozHR-KRN");
    expect(krn?.depositRouteId).toBe(DEPOSIT_KRN);
    expect(krn?.withdrawRouteId).toBe(WITHDRAW_KRN);
  });

  it("ignores a malformed vault override wholesale rather than applying part of it", async () => {
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS", JSON.stringify({ krn: VAULT_KRN, tcl: "not-an-address" }));
    vi.resetModules();
    const { hookrLpPools } = await import("@/lib/hookr-pools");
    expect(hookrLpPools().every((pool) => pool.vaultAddress === null)).toBe(true);
  });
});

describe("Hookr LP while nothing is deployed (today's shipped state)", () => {
  it("keeps every Hookr LP route fail-closed and out of every offered set", async () => {
    const { hookrLpConfigured, hookrLpContractsState } = await import("@/lib/hookr-pools");
    const { resolveRouteById, deployedRoutes } = await import("@/lib/routes");
    const { tokenBySymbol } = await import("@/lib/robinhood");

    expect(hookrLpContractsState()).toBe("absent");
    expect(hookrLpConfigured()).toBe(false);
    expect(resolveRouteById(DEPOSIT_KRN)).toBeNull();
    expect(resolveRouteById(WITHDRAW_KRN)).toBeNull();
    expect(tokenBySymbol("ozHR-KRN")).toBeNull();
    const ids = deployedRoutes().map((route) => route.id);
    expect(ids.some((id) => id.startsWith("hookr-lp-"))).toBe(false);
  });

  it("ships all four Hookr LP blueprints in the catalog, AFTER the deployable prefix", async () => {
    const { RECIPES } = await import("@/lib/blocks");
    const { DEPLOYABLE_RECIPE_COUNT } = await import("@/lib/agent-catalog");
    const ids = RECIPES.map((recipe) => recipe.id);
    for (const id of ["hookr-lp-in", "hookr-lp-from-eth", "hookr-lp-out", "hookr-lp-migrate"]) {
      expect(ids.indexOf(id), id).toBeGreaterThanOrEqual(DEPLOYABLE_RECIPE_COUNT);
    }
  });

  it("rejects the zap-in blueprint by name — the deposit adapter env var, not a vague no", async () => {
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const mapping = reduceChainToLiveRoute(await recipeChain("hookr-lp-in"));
    expect(mapping.deployable).toBe(false);
    if (mapping.deployable) throw new Error("expected refusal");
    expect(mapping.reasons.join(" ")).toContain("NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER");
  });

  it("refuses a partial contract set (all-or-nothing) and a pool with no known vault", async () => {
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER", DEPOSIT);
    vi.resetModules();
    const { hookrLpContractsState, hookrLpConfigured } = await import("@/lib/hookr-pools");
    const { resolveRouteById } = await import("@/lib/routes");
    expect(hookrLpContractsState()).toBe("partial");
    expect(hookrLpConfigured()).toBe(false);
    // The adapter address alone is not a route: the share token (the vault) is unknown.
    expect(resolveRouteById(DEPOSIT_KRN)).toBeNull();
  });
});

describe("Hookr LP once the deploy script's addresses and vaults are configured", () => {
  async function configureAll(): Promise<void> {
    stubContracts();
    stubVaults();
    vi.resetModules();
  }

  it("resolves per-pool routes against the hooked pool key, vault as the share token", async () => {
    await configureAll();
    const { resolveRouteById, routeCatalogReady, routeStaticHandoffReady, deployedRoutes } = await import("@/lib/routes");

    const deposit = resolveRouteById(DEPOSIT_KRN);
    expect(deposit).not.toBeNull();
    if (!deposit) return;
    expect(deposit.kind).toBe("lp-deposit");
    expect(deposit.adapter).toBe(DEPOSIT);
    expect(deposit.tokenIn.symbol).toBe("HOOKR");
    expect(deposit.tokenOut.symbol).toBe("ozHR-KRN");
    expect(deposit.tokenOut.address).toBe(VAULT_KRN);
    expect(deposit.tokenOut.decimals).toBe(18);
    expect(deposit.data).toBe("hooked-lp-deposit");
    expect(deposit.trackedAssets).toEqual([HOOKR, VAULT_KRN]);
    if (deposit.quote.source !== "range-deposit") throw new Error("expected a range-deposit quote");
    expect(deposit.quote.vault).toBe(VAULT_KRN);
    expect(deposit.quote.poolKey.hooks).toBe(HOOKR_HOOK);
    expect(deposit.quote.poolKey.fee).toBe(0x800000);
    expect(deposit.quote.poolKey.tickSpacing).toBe(60);
    expect(deposit.quote.zeroForOne).toBe(true); // HOOKR is currency0 of HOOKR/KRN
    expect(deposit.requiresSeededVault).toBe(false);
    expect(routeCatalogReady(DEPOSIT_KRN)).toBe(true);
    expect(routeStaticHandoffReady(DEPOSIT_KRN)).toBe(true);

    const withdraw = resolveRouteById(WITHDRAW_KRN);
    expect(withdraw).not.toBeNull();
    if (!withdraw) return;
    expect(withdraw.kind).toBe("lp-withdraw");
    expect(withdraw.adapter).toBe(WITHDRAW);
    expect(withdraw.tokenIn.address).toBe(VAULT_KRN);
    expect(withdraw.tokenOut.address).toBe(HOOKR);
    expect(withdraw.data).toBe("hooked-lp-withdraw");
    expect(withdraw.trackedAssets).toEqual([VAULT_KRN, HOOKR]);
    if (withdraw.quote.source !== "range-withdraw") throw new Error("expected a range-withdraw quote");
    expect(withdraw.quote.assetOutIsCurrency0).toBe(true);

    // A listed pool whose vault is not (yet) known stays closed on its own.
    expect(resolveRouteById(DEPOSIT_CANV5H)).toBeNull();
    const ids = deployedRoutes().map((route) => route.id);
    expect(ids).toEqual(expect.arrayContaining([DEPOSIT_KRN, WITHDRAW_KRN, DEPOSIT_TCL, "hookr-lp-withdraw-tcl"]));
    expect(ids).not.toContain(DEPOSIT_CANV5H);
  });

  it("encodes and recognises the two hooked step-data shapes, pinned to the route's target", async () => {
    await configureAll();
    const { resolveRouteById, stepDataFitsRoute, resolveRouteFromStep } = await import("@/lib/routes");
    const { encodeStepData } = await import("@/lib/openzap");
    const deposit = resolveRouteById(DEPOSIT_KRN);
    const depositTcl = resolveRouteById(DEPOSIT_TCL);
    const withdraw = resolveRouteById(WITHDRAW_KRN);
    if (!deposit || !depositTcl || !withdraw) throw new Error("routes must resolve");

    const depositData = encodeStepData(deposit, 5n);
    expect(depositData).toBe(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [VAULT_KRN, 5n]),
    );
    expect(stepDataFitsRoute(deposit, depositData)).toBe(true);
    // Another pool's vault in the data is NOT this route, same adapter or not.
    expect(stepDataFitsRoute(deposit, encodeStepData(depositTcl, 5n))).toBe(false);
    // The old one-word shape is not a hooked deposit.
    expect(stepDataFitsRoute(deposit, encodeAbiParameters([{ type: "uint256" }], [5n]))).toBe(false);
    expect(stepDataFitsRoute(deposit, "0x")).toBe(false);

    const withdrawData = encodeStepData(withdraw, 7n);
    expect(withdrawData).toBe(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [HOOKR, 7n]));
    expect(stepDataFitsRoute(withdraw, withdrawData)).toBe(true);
    expect(stepDataFitsRoute(withdraw, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [KRN, 7n]))).toBe(false);

    // The universal adapter serves every pool: an existing capsule's step is
    // matched back to the pool its tracked pair and data name, not the first
    // route that happens to share the adapter address.
    const fromStep = resolveRouteFromStep(DEPOSIT, HOOKR, [HOOKR, VAULT_TCL], encodeStepData(depositTcl, 0n));
    expect(fromStep?.id).toBe(DEPOSIT_TCL);
    expect(resolveRouteFromStep(DEPOSIT, HOOKR, [HOOKR, VAULT_TCL], depositData)).toBeNull();
    expect(resolveRouteFromStep(WITHDRAW, VAULT_KRN, [VAULT_KRN, HOOKR], withdrawData)?.id).toBe(WITHDRAW_KRN);
  });

  it("makes zap in and zap out deployable as one signed step each", async () => {
    await configureAll();
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const zapIn = reduceChainToLiveRoute(await recipeChain("hookr-lp-in"));
    expect(zapIn.deployable).toBe(true);
    if (!zapIn.deployable) return;
    expect(zapIn.steps.map((step) => step.routeId)).toEqual([DEPOSIT_KRN]);

    const zapOut = reduceChainToLiveRoute(await recipeChain("hookr-lp-out"));
    expect(zapOut.deployable).toBe(true);
    if (!zapOut.deployable) return;
    expect(zapOut.steps.map((step) => step.routeId)).toEqual([WITHDRAW_KRN]);
  });

  it("reduces the migration to two steps with HOOKR carried, and pins the intermediate floor", async () => {
    await configureAll();
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const { resolveLivePolicyPlan, buildLivePolicy } = await import("@/lib/live-policy");
    const migrate = reduceChainToLiveRoute(await recipeChain("hookr-lp-migrate"));
    expect(migrate.deployable).toBe(true);
    if (!migrate.deployable) return;
    expect(migrate.steps.map((step) => step.routeId)).toEqual([WITHDRAW_KRN, DEPOSIT_TCL]);

    const resolved = resolveLivePolicyPlan({
      version: 1,
      steps: [
        { routeId: WITHDRAW_KRN, amountIn: "1" },
        { routeId: DEPOSIT_TCL, amountIn: "10000" },
      ],
    });
    expect(resolved.trackedAssets).toEqual(expect.arrayContaining([VAULT_KRN, HOOKR, VAULT_TCL]));
    const owner = getAddress("0x9999999999999999999999999999999999999999");
    const policy = buildLivePolicy(owner, resolved);
    expect(policy.steps).toHaveLength(2);
    // Step 1 settles in HOOKR with a floor of exactly step 2's frozen amount.
    expect(policy.steps[0].data).toBe(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [HOOKR, 10_000n * 10n ** 18n]),
    );
    // Step 2 names pool B's vault; its floor is the signed intent's job.
    expect(policy.steps[1].data).toBe(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [VAULT_TCL, 0n]),
    );
    expect(policy.steps[1].tokenIn).toBe(HOOKR);
  });

  it("chains the HOOKR buy into a pool deposit once the swap adapter is also configured", async () => {
    await configureAll();
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER", HOOKR_SWAP_ADAPTER);
    vi.resetModules();
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const mapping = reduceChainToLiveRoute(await recipeChain("hookr-lp-from-eth"));
    expect(mapping.deployable).toBe(true);
    if (!mapping.deployable) return;
    expect(mapping.steps.map((step) => step.routeId)).toEqual(["robinhood-v4-weth-hookr", DEPOSIT_KRN]);
  });

  it("keeps a wrong zero-vault override closed", async () => {
    stubContracts();
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS", JSON.stringify({ krn: zeroAddress }));
    vi.resetModules();
    const { resolveRouteById } = await import("@/lib/routes");
    expect(resolveRouteById(DEPOSIT_KRN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Hookr modular generations (V2/V3): native-quoted markets, per-market hook instances, and the
// coordinator-bound market swap route.
// ---------------------------------------------------------------------------------------------

const AEWETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const MARKET_SWAP = getAddress("0x8888888888888888888888888888888888888888");
const V3_TOKEN = getAddress("0x22F749EDB75fCA5438cD978aC0Af9b5d9f1F72d1"); // TESTINPROD (V3 canary)
const V3_INSTANCE = getAddress("0xD2Ad501Fb4B46dA9Ea7E5153CB7fa87829C468CC");
// The live V3 existing-token canary market's pool id, read off the coordinator on 2026-09-04.
const V3_POOL_ID = "0x07bd1a49322beea87ca9df64602201487595f4b776ba33910b375025e83646d3";
const VAULT_V3 = getAddress("0x9999999999999999999999999999999999999991");
const V3_TOKEN_B = getAddress("0xa6D53173e890AA5914924b9173E8eB2b364BeB72");
const V3_INSTANCE_B = getAddress("0x20A433A26a6Fc58902C0f74543f9faC6fEBBe8cC");
const VAULT_V3_B = getAddress("0x9999999999999999999999999999999999999992");

function stubModularMarkets(): void {
  stubContracts();
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_MARKET_SWAP_ADAPTER", MARKET_SWAP);
  stubVaults();
  vi.stubEnv(
    "NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS",
    JSON.stringify([
      { key: "tip", symbol: "TIP", name: "Testinprod", token: V3_TOKEN, hooks: V3_INSTANCE, generation: "v3", quote: "ETH", vault: VAULT_V3 },
      { key: "tipb", symbol: "TIPB", name: "Testinprod B", token: V3_TOKEN_B, hooks: V3_INSTANCE_B, generation: "v3", quote: "ETH", vault: VAULT_V3_B },
    ]),
  );
  vi.resetModules();
}

describe("Hookr modular markets (V2/V3) once contracts and market rows are configured", () => {
  it("is absent from every surface while no modular row exists, and needs the market adapter too", async () => {
    stubContracts();
    stubVaults();
    vi.resetModules();
    const { hookrLpContractsState, hookrLpPools, hookrMarketSubjectSymbols } = await import("@/lib/hookr-pools");
    const { RECIPES } = await import("@/lib/blocks");
    // Three of four contracts: partial, so everything stays closed.
    expect(hookrLpContractsState()).toBe("partial");
    expect(hookrLpPools().some((pool) => pool.modular)).toBe(false);
    expect(hookrMarketSubjectSymbols()).toEqual([]);
    expect(RECIPES.some((recipe) => recipe.id.startsWith("hookr-market"))).toBe(false);
  });

  it("derives the V3 canary market's pool id from its native quote and per-market instance", async () => {
    stubModularMarkets();
    const { hookrLpPools, hookrLpConfigured } = await import("@/lib/hookr-pools");
    expect(hookrLpConfigured()).toBe(true);
    const tip = hookrLpPools().find((pool) => pool.key === "tip");
    expect(tip?.modular).toBe(true);
    expect(tip?.poolId).toBe(V3_POOL_ID);
    expect(tip?.poolKey).toEqual({ currency0: zeroAddress, currency1: V3_TOKEN, fee: 0x800000, tickSpacing: 60, hooks: V3_INSTANCE });
    expect(tip?.poolLabel).toBe("ETH/TIP");
    expect(tip?.quoteFaceSymbol).toBe("WETH");
    expect(tip?.quoteFaceAddress).toBe(AEWETH);
    expect(tip?.marketBuyRouteId).toBe("hookr-market-buy-tip");
    expect(tip?.vaultAddress).toBe(VAULT_V3);
  });

  it("drops the whole market list on one malformed row", async () => {
    stubContracts();
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_MARKET_SWAP_ADAPTER", MARKET_SWAP);
    vi.stubEnv(
      "NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS",
      JSON.stringify([
        { key: "tip", symbol: "TIP", token: V3_TOKEN, hooks: V3_INSTANCE, generation: "v3", quote: "ETH" },
        { key: "bad", symbol: "BAD", token: V3_TOKEN_B, hooks: "nope", generation: "v3", quote: "ETH" },
      ]),
    );
    vi.resetModules();
    const { hookrLpPools } = await import("@/lib/hookr-pools");
    expect(hookrLpPools().some((pool) => pool.modular)).toBe(false);
  });

  it("resolves market buy/sell routes against the market's own hooked key with pool-id step data", async () => {
    stubModularMarkets();
    const { resolveRouteById, routeCatalogReady, stepDataFitsRoute, resolveRouteFromStep } = await import("@/lib/routes");
    const { encodeStepData } = await import("@/lib/openzap");

    const buy = resolveRouteById("hookr-market-buy-tip");
    expect(buy).not.toBeNull();
    if (!buy) return;
    expect(buy.kind).toBe("swap");
    expect(buy.adapter).toBe(MARKET_SWAP);
    expect(buy.tokenIn.address).toBe(AEWETH);
    expect(buy.tokenOut.address).toBe(V3_TOKEN);
    expect(buy.tokenOut.symbol).toBe("TIP");
    expect(buy.data).toBe("hookr-market");
    expect(buy.trackedAssets).toEqual([AEWETH, V3_TOKEN]);
    if (buy.quote.source !== "v4") throw new Error("expected a v4 quote");
    expect(buy.quote.poolKey.hooks).toBe(V3_INSTANCE);
    expect(buy.quote.poolKey.currency0).toBe(zeroAddress);
    expect(buy.quote.zeroForOne).toBe(true);
    expect(routeCatalogReady("hookr-market-buy-tip")).toBe(true);

    const sell = resolveRouteById("hookr-market-sell-tip");
    if (!sell || sell.quote.source !== "v4") throw new Error("sell route must resolve");
    expect(sell.tokenIn.address).toBe(V3_TOKEN);
    expect(sell.tokenOut.address).toBe(AEWETH);
    expect(sell.quote.zeroForOne).toBe(false);
    expect(sell.trackedAssets).toEqual([AEWETH, V3_TOKEN]);

    const data = encodeStepData(buy, 9n);
    expect(data).toBe(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [V3_POOL_ID, 9n]));
    expect(stepDataFitsRoute(buy, data)).toBe(true);
    expect(stepDataFitsRoute(buy, encodeAbiParameters([{ type: "uint256" }], [9n]))).toBe(false);
    const sellB = resolveRouteById("hookr-market-sell-tipb");
    if (!sellB) throw new Error("sell B must resolve");
    // Another market's pool id in the data is NOT this route, same adapter or not.
    expect(stepDataFitsRoute(buy, encodeStepData(resolveRouteById("hookr-market-buy-tipb")!, 9n))).toBe(false);
    // An existing capsule's buy step resolves to the market its pool id names.
    expect(resolveRouteFromStep(MARKET_SWAP, AEWETH, [AEWETH, V3_TOKEN_B], encodeStepData(resolveRouteById("hookr-market-buy-tipb")!, 0n))?.id)
      .toBe("hookr-market-buy-tipb");
    expect(resolveRouteFromStep(MARKET_SWAP, V3_TOKEN_B, [AEWETH, V3_TOKEN_B], encodeStepData(sellB, 0n))?.id).toBe("hookr-market-sell-tipb");
  });

  it("resolves native-quoted LP routes with aeWETH as the quote face", async () => {
    stubModularMarkets();
    const { resolveRouteById } = await import("@/lib/routes");
    const deposit = resolveRouteById("hookr-lp-deposit-tip");
    expect(deposit).not.toBeNull();
    if (!deposit || deposit.quote.source !== "range-deposit") throw new Error("deposit must resolve");
    expect(deposit.tokenIn.address).toBe(AEWETH);
    expect(deposit.tokenOut.address).toBe(VAULT_V3);
    expect(deposit.quote.poolKey.currency0).toBe(zeroAddress);
    expect(deposit.quote.poolKey.hooks).toBe(V3_INSTANCE);
    expect(deposit.quote.zeroForOne).toBe(true);
    const withdraw = resolveRouteById("hookr-lp-withdraw-tip");
    if (!withdraw || withdraw.quote.source !== "range-withdraw") throw new Error("withdraw must resolve");
    expect(withdraw.tokenOut.address).toBe(AEWETH);
    expect(withdraw.quote.assetOutIsCurrency0).toBe(true);
  });

  it("ships the modular blueprints after the prefix and reduces them, including the three-step V5 → V3 move", async () => {
    stubModularMarkets();
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER", HOOKR_SWAP_ADAPTER);
    vi.resetModules();
    const { RECIPES } = await import("@/lib/blocks");
    const { DEPLOYABLE_RECIPE_COUNT } = await import("@/lib/agent-catalog");
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const ids = RECIPES.map((recipe) => recipe.id);
    for (const id of ["hookr-market-buy", "hookr-market-lp-in", "hookr-market-lp-out", "hookr-v5-to-market", "hookr-market-migrate"]) {
      expect(ids.indexOf(id), id).toBeGreaterThanOrEqual(DEPLOYABLE_RECIPE_COUNT);
    }

    const buy = reduceChainToLiveRoute(await recipeChain("hookr-market-buy"));
    expect(buy.deployable).toBe(true);
    if (buy.deployable) expect(buy.steps.map((step) => step.routeId)).toEqual(["hookr-market-buy-tip"]);

    const lpIn = reduceChainToLiveRoute(await recipeChain("hookr-market-lp-in"));
    expect(lpIn.deployable).toBe(true);
    if (lpIn.deployable) expect(lpIn.steps.map((step) => step.routeId)).toEqual(["hookr-lp-deposit-tip"]);

    const migrate = reduceChainToLiveRoute(await recipeChain("hookr-market-migrate"));
    expect(migrate.deployable).toBe(true);
    if (migrate.deployable) expect(migrate.steps.map((step) => step.routeId)).toEqual(["hookr-lp-withdraw-tip", "hookr-lp-deposit-tipb"]);

    const v5ToV3 = reduceChainToLiveRoute(await recipeChain("hookr-v5-to-market"));
    expect(v5ToV3.deployable).toBe(true);
    if (v5ToV3.deployable) {
      expect(v5ToV3.steps.map((step) => step.routeId)).toEqual([
        "hookr-lp-withdraw-krn",
        "robinhood-v4-hookr-weth",
        "hookr-lp-deposit-tip",
      ]);
    }
  });
});
