import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress } from "viem";

import { makeNode, type ChainNode, type ParamValue } from "@/lib/blocks";

/**
 * The HOOKR slice, end to end at the app layer: the native-pool routes, the
 * automation market, and the three catalog blueprints (buy, DCA, trigger).
 *
 * Everything here runs in BOTH deployment states, because the fail-closed
 * half is the product claim: until `DeployRobinhoodHookr.s.sol` has broadcast
 * and its addresses are configured, no surface may offer a HOOKR route — and
 * the moment they are configured, every surface must light up without a code
 * change. The onchain half of this feature is proven separately by
 * `contracts/test/RobinhoodV4NativePoolAdapter.fork.t.sol` against the live
 * factories.
 */

const HOOKR_ADDRESS = getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c");
const AEWETH_ADDRESS = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const HOOKR_POOL_ID = "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf";

const ADAPTER = getAddress("0x2222222222222222222222222222222222222222");
const TRIGGER_SOURCE = getAddress("0x3333333333333333333333333333333333333333");
const ORIENTED_SOURCE = getAddress("0x4444444444444444444444444444444444444444");

const HOOKR_BUY_ID = "robinhood-v4-weth-hookr";
const HOOKR_SELL_ID = "robinhood-v4-hookr-weth";

function stubAdapter(): void {
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER", ADAPTER);
}

function stubPriceSources(): void {
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_POOL_PRICE_SOURCE", TRIGGER_SOURCE);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_ORIENTED_PRICE_SOURCE", ORIENTED_SOURCE);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Build the ChainNode list for a catalog recipe, exactly as the landing does. */
async function recipeChain(id: string): Promise<ChainNode[]> {
  const { RECIPES } = await import("@/lib/blocks");
  const recipe = RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error(`recipe ${id} is not in the catalog`);
  return recipe.blocks.map(([blockId, params], index) =>
    makeNode(blockId, `${id}-${index}`, params as Record<string, ParamValue> | undefined),
  );
}

describe("HOOKR while nothing is deployed (today's shipped state)", () => {
  it("keeps every HOOKR route fail-closed and out of every offered set", async () => {
    const { resolveRouteById, deployedRoutes } = await import("@/lib/routes");
    const { automationRouteIds, automationMarketForRoute } = await import("@/lib/automate");
    const { openZapHookrAutomationConfigured } = await import("@/lib/robinhood");

    expect(resolveRouteById(HOOKR_BUY_ID)).toBeNull();
    expect(resolveRouteById(HOOKR_SELL_ID)).toBeNull();
    expect(deployedRoutes().map((route) => route.id)).not.toContain(HOOKR_BUY_ID);
    expect(automationRouteIds()).not.toContain(HOOKR_BUY_ID);
    expect(openZapHookrAutomationConfigured()).toBe(false);

    // The market EXISTS — the console can name it — but holds no sources yet,
    // and can never stack (the stack leg is welded to the 0xZAPS adapter).
    const market = automationMarketForRoute(HOOKR_BUY_ID);
    expect(market).not.toBeNull();
    expect(market?.tokenLabel).toBe("HOOKR");
    expect(market?.triggerPriceSource).toBeNull();
    expect(market?.relativePriceSource).toBeNull();
    expect(market?.stackPriceSource).toBeNull();
  });

  it("ships all three HOOKR blueprints in the catalog, AFTER the deployable prefix", async () => {
    const { RECIPES } = await import("@/lib/blocks");
    const { DEPLOYABLE_RECIPE_COUNT } = await import("@/lib/agent-catalog");
    const ids = RECIPES.map((recipe) => recipe.id);
    for (const id of ["hookr-buy", "hookr-dca", "hookr-trigger"]) {
      const index = ids.indexOf(id);
      expect(index, id).toBeGreaterThanOrEqual(DEPLOYABLE_RECIPE_COUNT);
    }
  });

  it("rejects the buy blueprint by name — the adapter env var, not a vague no", async () => {
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const mapping = reduceChainToLiveRoute(await recipeChain("hookr-buy"));
    expect(mapping.deployable).toBe(false);
    if (mapping.deployable) throw new Error("expected refusal");
    expect(mapping.reasons.join(" ")).toContain("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER");
  });

  it("refuses HOOKR automation when only the adapter is configured (sources missing)", async () => {
    stubAdapter();
    vi.resetModules();
    const { resolveRouteById } = await import("@/lib/routes");
    const { automationRouteIds } = await import("@/lib/automate");

    // The route exists for Zap now the moment the adapter is live…
    expect(resolveRouteById(HOOKR_BUY_ID)).not.toBeNull();
    // …but automation stays closed: an intent would name an oracle the
    // factories' registries have never allowlisted.
    expect(automationRouteIds()).not.toContain(HOOKR_BUY_ID);
  });

  it("refuses a partial price-source set (all-or-nothing, like every optional lineage)", async () => {
    stubAdapter();
    vi.stubEnv("NEXT_PUBLIC_OPENZAP_HOOKR_POOL_PRICE_SOURCE", TRIGGER_SOURCE);
    vi.resetModules();
    const { openZapHookrAutomationConfigured } = await import("@/lib/robinhood");
    const { automationRouteIds } = await import("@/lib/automate");
    expect(openZapHookrAutomationConfigured()).toBe(false);
    expect(automationRouteIds()).not.toContain(HOOKR_BUY_ID);
  });
});

describe("HOOKR once the deploy script's addresses are configured", () => {
  async function configureAll() {
    stubAdapter();
    stubPriceSources();
    vi.resetModules();
  }

  it("resolves both routes against the REAL native pool key, aeWETH standing in for currency0", async () => {
    await configureAll();
    const { resolveRouteById, routeCatalogReady, routeStaticHandoffReady } = await import("@/lib/routes");

    const buy = resolveRouteById(HOOKR_BUY_ID);
    expect(buy).not.toBeNull();
    if (!buy) return;
    expect(buy.kind).toBe("swap");
    expect(buy.adapter).toBe(ADAPTER);
    expect(buy.tokenIn.symbol).toBe("aeWETH");
    expect(buy.tokenOut.symbol).toBe("HOOKR");
    expect(buy.tokenOut.address).toBe(HOOKR_ADDRESS);
    expect(buy.tokenOut.decimals).toBe(18);
    expect(buy.data).toBe("min-amount-out");
    // The QUOTE pins the real pool: native currency0, HOOKR currency1, 2500/25, hookless.
    if (buy.quote.source !== "v4") throw new Error("expected a v4 quote");
    expect(buy.quote.poolKey.currency0).toBe(zeroAddress);
    expect(buy.quote.poolKey.currency1).toBe(HOOKR_ADDRESS);
    expect(buy.quote.poolKey.fee).toBe(2500);
    expect(buy.quote.poolKey.tickSpacing).toBe(25);
    expect(buy.quote.poolKey.hooks).toBe(zeroAddress);
    // Spending the native side: zeroForOne is TRUE even though tokenIn is aeWETH.
    expect(buy.quote.zeroForOne).toBe(true);
    // The capsule tracks the ERC-20 pair it can actually measure — never address(0).
    expect(buy.trackedAssets).toEqual([AEWETH_ADDRESS, HOOKR_ADDRESS]);

    const sell = resolveRouteById(HOOKR_SELL_ID);
    expect(sell).not.toBeNull();
    if (!sell) return;
    expect(sell.tokenIn.symbol).toBe("HOOKR");
    expect(sell.tokenOut.symbol).toBe("aeWETH");
    if (sell.quote.source !== "v4") throw new Error("expected a v4 quote");
    expect(sell.quote.zeroForOne).toBe(false);
    expect(sell.trackedAssets).toEqual([AEWETH_ADDRESS, HOOKR_ADDRESS]);

    expect(routeCatalogReady(HOOKR_BUY_ID)).toBe(true);
    expect(routeCatalogReady(HOOKR_SELL_ID)).toBe(true);
    expect(routeStaticHandoffReady(HOOKR_BUY_ID)).toBe(true);
  });

  it("round-trips both directions through resolveRouteFromStep and rejects a drifted pair", async () => {
    await configureAll();
    const { resolveRouteFromStep } = await import("@/lib/routes");

    const buy = resolveRouteFromStep(ADAPTER, AEWETH_ADDRESS, [AEWETH_ADDRESS, HOOKR_ADDRESS], "0x");
    expect(buy?.id).toBe(HOOKR_BUY_ID);
    const sell = resolveRouteFromStep(
      ADAPTER,
      HOOKR_ADDRESS,
      [AEWETH_ADDRESS, HOOKR_ADDRESS],
      `0x${"0".repeat(63)}1`,
    );
    expect(sell?.id).toBe(HOOKR_SELL_ID);

    // A policy tracking the pool's literal native currency0 is NOT this route.
    expect(resolveRouteFromStep(ADAPTER, AEWETH_ADDRESS, [zeroAddress, HOOKR_ADDRESS], "0x")).toBeNull();
    // Routing bytes beyond the bounded minimum-out are refused.
    expect(
      resolveRouteFromStep(ADAPTER, AEWETH_ADDRESS, [AEWETH_ADDRESS, HOOKR_ADDRESS], "0x1234"),
    ).toBeNull();
  });

  it("opens the automation market with exactly the configured sources, and still no stack", async () => {
    await configureAll();
    const { automationRouteIds, automationMarketForRoute, thresholdPresetsFor } = await import("@/lib/automate");

    expect(automationRouteIds()).toContain(HOOKR_BUY_ID);
    expect(automationRouteIds()).toContain(HOOKR_SELL_ID);
    const market = automationMarketForRoute(HOOKR_BUY_ID);
    expect(market?.triggerPriceSource).toBe(TRIGGER_SOURCE);
    expect(market?.relativePriceSource).toBe(ORIENTED_SOURCE);
    expect(market?.stackPriceSource).toBeNull();

    // The trigger copy names the market's token, with the same market-independent ids.
    const presets = thresholdPresetsFor(market?.tokenLabel ?? "");
    expect(presets.map((preset) => preset.id)).toEqual(["up5", "up10", "up25", "down5", "down10", "down25"]);
    expect(presets.find((preset) => preset.id === "down10")?.label).toBe("HOOKR falls −10%");
  });

  it("makes the buy blueprint deployable as one signed step on the HOOKR route", async () => {
    await configureAll();
    const { reduceChainToLiveRoute } = await import("@/lib/deployable");
    const mapping = reduceChainToLiveRoute(await recipeChain("hookr-buy"));
    expect(mapping.deployable).toBe(true);
    if (!mapping.deployable) throw new Error(`expected deployable, got ${JSON.stringify(mapping)}`);
    expect(mapping.routeId).toBe(HOOKR_BUY_ID);
    expect(mapping.steps).toEqual([{ routeId: HOOKR_BUY_ID, amountIn: "0.001" }]);
    expect(mapping.slippageBps).toBe(100);
  });

  it("reduces the DCA blueprint to a live recurring automation and round-trips the handoff", async () => {
    await configureAll();
    const { reduceChainToAutomation, automationHandoff } = await import("@/lib/automation-design");
    const { readAutomationHandoff } = await import("@/lib/automate");

    const design = reduceChainToAutomation(await recipeChain("hookr-dca"));
    expect(design.deployable).toBe(true);
    if (!design.deployable) throw new Error(`expected automation, got ${JSON.stringify(design)}`);
    expect(design.mode).toBe("recurring");
    expect(design.routeId).toBe(HOOKR_BUY_ID);
    if (design.mode !== "recurring") return;
    expect(design.intervalId).toBe("weekly");
    expect(design.maxRuns).toBe(10);
    expect(design.validDays).toBe(90);

    const imported = readAutomationHandoff(
      new URL(automationHandoff(design), "https://www.0xzaps.com").searchParams,
    );
    expect(imported?.routeId).toBe(HOOKR_BUY_ID);
    expect(imported?.mode).toBe("recurring");
  });

  it("reduces the trigger blueprint to a dip-buy trigger with a signed expiry", async () => {
    await configureAll();
    const { reduceChainToAutomation } = await import("@/lib/automation-design");

    const design = reduceChainToAutomation(await recipeChain("hookr-trigger"));
    expect(design.deployable).toBe(true);
    if (!design.deployable) throw new Error(`expected automation, got ${JSON.stringify(design)}`);
    expect(design.mode).toBe("trigger");
    expect(design.routeId).toBe(HOOKR_BUY_ID);
    if (design.mode !== "trigger") return;
    expect(design.thresholdId).toBe("down10");
    expect(design.validDays).toBe(30);
  });

  it("keeps the pinned pool identity: the route quotes the pool that hashes to 0x590d…5fdf", async () => {
    await configureAll();
    const { resolveRouteById } = await import("@/lib/routes");
    const { keccak256, encodeAbiParameters } = await import("viem");

    const buy = resolveRouteById(HOOKR_BUY_ID);
    if (!buy || buy.quote.source !== "v4") throw new Error("expected the v4 route");
    const { poolKey } = buy.quote;
    const poolId = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      ),
    );
    expect(poolId).toBe(HOOKR_POOL_ID);
  });
});
