import { protocolName, type ProtocolId } from "@/lib/protocols";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@/lib/robinhood";
import type { VirtualMarketId, VirtualOrderSide } from "@/lib/virtual-trading";

export type VirtualQuoteAssetId = "usdg" | VirtualMarketId;

export type VirtualAssetVisual = {
  readonly symbol: string;
  readonly name: string;
  readonly imageSrc: string | null;
  readonly monogram?: string;
};

/**
 * Asset identity used by the paper-trading interface.
 *
 * USDG intentionally stays typographic until an authenticated local design
 * asset is vendored. The virtual ledger mirrors its notional at the edge of a
 * quote; it never claims to custody the token.
 */
export const VIRTUAL_ASSET_VISUALS: Readonly<
  Record<VirtualQuoteAssetId, VirtualAssetVisual>
> = {
  usdg: {
    symbol: "USDG",
    name: "Global Dollar",
    imageSrc: null,
    monogram: "$",
  },
  zaps: {
    symbol: "0xZAPS",
    name: "OpenZaps",
    imageSrc: "/0xzaps-token.svg",
  },
  weth: {
    symbol: "aeWETH",
    name: "Wrapped Ether",
    imageSrc: "/protocols/ethereum.svg",
  },
};

const VIRTUAL_TRADING_PROTOCOL: ProtocolId = "uniswap-v4";

/** Every Virtual Trading quote is read from the pinned Uniswap v4 Quoter. */
export const VIRTUAL_TRADING_VENUE = {
  protocol: VIRTUAL_TRADING_PROTOCOL,
  name: protocolName(VIRTUAL_TRADING_PROTOCOL),
  network: robinhoodChain.name,
  chainId: ROBINHOOD_CHAIN_ID,
} as const;

export function virtualQuotePath(
  marketId: VirtualMarketId,
  side: VirtualOrderSide,
): readonly VirtualQuoteAssetId[] {
  const buyPath: readonly VirtualQuoteAssetId[] = marketId === "zaps"
    ? ["usdg", "weth", "zaps"]
    : ["usdg", "weth"];

  return side === "buy" ? buyPath : [...buyPath].reverse();
}

export function virtualQuotePoolCount(marketId: VirtualMarketId): 1 | 2 {
  return marketId === "zaps" ? 2 : 1;
}

export function virtualQuoteRouteLabel(
  marketId: VirtualMarketId,
  side: VirtualOrderSide,
): string {
  const path = virtualQuotePath(marketId, side)
    .map((assetId) => VIRTUAL_ASSET_VISUALS[assetId].symbol)
    .join(" to ");
  const pools = virtualQuotePoolCount(marketId);
  return `${path} through ${pools} pinned Uniswap v4 pool${pools === 1 ? "" : "s"}`;
}
