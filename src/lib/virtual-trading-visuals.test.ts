import { existsSync } from "node:fs";
import { join } from "node:path";
import { isAddressEqual, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { ROBINHOOD_ADAPTERS } from "@/lib/chains";
import { protocolName } from "@/lib/protocols";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_TOKENS,
} from "@/lib/robinhood";
import { resolveRouteById, type Route } from "@/lib/routes";
import { VIRTUAL_MARKETS } from "@/lib/virtual-trading";
import {
  VIRTUAL_ASSET_VISUALS,
  VIRTUAL_TRADING_VENUE,
  virtualQuotePath,
  virtualQuotePoolCount,
  virtualQuoteRouteLabel,
} from "@/lib/virtual-trading-visuals";

function symbolForAddress(address: Address): string {
  const token = Object.values(ROBINHOOD_TOKENS)
    .find((candidate) => isAddressEqual(candidate.address, address));
  if (!token) throw new Error(`No canonical token for ${address}`);
  return token.symbol;
}

function resolvedRouteSymbols(route: Route): string[] {
  if (route.quote.source === "v4") {
    return [route.tokenIn.symbol, route.tokenOut.symbol];
  }
  if (route.quote.source !== "v4-route") {
    throw new Error(`Virtual Trading route ${route.id} is not a v4 quote`);
  }

  const symbols = [route.tokenIn.symbol];
  for (const hop of route.quote.hops) {
    const output = hop.zeroForOne
      ? hop.poolKey.currency1
      : hop.poolKey.currency0;
    symbols.push(symbolForAddress(output));
  }
  return symbols;
}

describe("Virtual Trading visual truth", () => {
  it("uses a real local asset mark for every tradable market", () => {
    for (const marketId of Object.keys(VIRTUAL_MARKETS) as Array<keyof typeof VIRTUAL_MARKETS>) {
      const src = VIRTUAL_ASSET_VISUALS[marketId].imageSrc;
      expect(src, marketId).toMatch(/^\/.+\.svg$/);
      expect(existsSync(join(process.cwd(), "public", src!)), marketId).toBe(true);
    }
  });

  it("identifies the one venue and network used by every quote", () => {
    expect(VIRTUAL_TRADING_VENUE).toEqual({
      protocol: "uniswap-v4",
      name: protocolName("uniswap-v4"),
      network: "Robinhood Chain",
      chainId: ROBINHOOD_CHAIN_ID,
    });
  });

  it("matches every visual path to its resolved adapter route", () => {
    for (const marketId of Object.keys(VIRTUAL_MARKETS) as Array<keyof typeof VIRTUAL_MARKETS>) {
      for (const side of ["buy", "sell"] as const) {
        const routeId = side === "buy"
          ? VIRTUAL_MARKETS[marketId].buyRouteId
          : VIRTUAL_MARKETS[marketId].sellRouteId;
        const spec = ROBINHOOD_ADAPTERS.find((candidate) => candidate.id === routeId);
        const route = resolveRouteById(routeId);
        expect(spec?.chainId, routeId).toBe(ROBINHOOD_CHAIN_ID);
        expect(route, routeId).not.toBeNull();

        const visualSymbols = virtualQuotePath(marketId, side)
          .map((assetId) => VIRTUAL_ASSET_VISUALS[assetId].symbol);
        expect(visualSymbols, routeId).toEqual(resolvedRouteSymbols(route!));
        expect(virtualQuotePoolCount(marketId), routeId).toBe(
          route!.quote.source === "v4-route" ? route!.quote.hops.length : 1,
        );
      }
    }
  });

  it("qualifies the hooked pool only on the 0xZAPS leg", () => {
    const zaps = resolveRouteById(VIRTUAL_MARKETS.zaps.buyRouteId);
    expect(zaps?.quote.source).toBe("v4-route");
    if (!zaps || zaps.quote.source !== "v4-route") return;
    expect(zaps.quote.hops.map((hop) => hop.poolKey.hooks)).toEqual([
      zeroAddress,
      ROBINHOOD_LIQUIDITY.hook,
    ]);

    const weth = resolveRouteById(VIRTUAL_MARKETS.weth.buyRouteId);
    expect(weth?.quote.source).toBe("v4");
    if (!weth || weth.quote.source !== "v4") return;
    expect(weth.quote.poolKey.hooks).toBe(zeroAddress);
  });

  it("keeps the pool count and accessible route label aligned", () => {
    expect(virtualQuotePoolCount("zaps")).toBe(2);
    expect(virtualQuotePoolCount("weth")).toBe(1);
    expect(virtualQuoteRouteLabel("zaps", "buy")).toBe(
      "USDG to aeWETH to 0xZAPS through 2 pinned Uniswap v4 pools",
    );
    expect(virtualQuoteRouteLabel("weth", "sell")).toBe(
      "aeWETH to USDG through 1 pinned Uniswap v4 pool",
    );
  });
});
