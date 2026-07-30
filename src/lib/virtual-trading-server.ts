import {
  createPublicClient,
  http,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";

import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "@/lib/robinhood";
import { quoteRoute, type RouteQuoteResult } from "@/lib/route-quote";
import { resolveRouteById, type Route } from "@/lib/routes";
import {
  PRICE_WAD_DECIMALS,
  USDG_DECIMALS,
  VIRTUAL_MARKETS,
  VIRTUAL_QUOTE_TTL_MS,
  routeForVirtualOrder,
  type VirtualFill,
  type VirtualMarketId,
  type VirtualMarketMark,
  type VirtualMarketSnapshot,
  type VirtualOrderSide,
} from "@/lib/virtual-trading";

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

const MARK_SAMPLE_INPUT_RAW: Record<VirtualMarketId, bigint> = {
  zaps: 1_000_000n * 10n ** BigInt(VIRTUAL_MARKETS.zaps.decimals),
  weth: 10n ** 16n, // 0.01 aeWETH
};
const MAX_UINT128 = (1n << 128n) - 1n;

type RouteQuoter = (
  client: PublicClient,
  route: Route,
  amountIn: bigint,
  account: `0x${string}`,
  blockNumber?: bigint,
  blockHash?: Hex,
) => Promise<RouteQuoteResult>;

interface CanonicalBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface VirtualQuoteInput {
  marketId: VirtualMarketId;
  side: VirtualOrderSide;
  inputRaw: bigint;
  clientOrderId: string;
  portfolioRevision: number;
}

export interface VirtualPortfolioValuationInput {
  zapsRaw: bigint;
  wethRaw: bigint;
  portfolioRevision: number;
}

export interface VirtualPositionValuation {
  quoteKind: "standalone-full-position";
  routeId: string;
  inputRaw: string;
  /** Standalone USDG output. Do not add these across shared-liquidity routes. */
  outputRaw: string;
}

export interface VirtualPortfolioValuation {
  portfolioRevision: number;
  chainId: 4663;
  blockNumber: string;
  blockHash: Hex;
  blockTimestamp: string;
  readAt: string;
  source: "canonical Robinhood Chain head eth_call";
  positions: Record<VirtualMarketId, VirtualPositionValuation>;
  portfolioRouteIds: readonly [
    "robinhood-v4-zaps-weth",
    "robinhood-v4-weth-usdg",
  ];
  /** Deterministic aggregate exit: 0xZAPS -> aeWETH, then all aeWETH -> USDG. */
  portfolioOutputRaw: string;
}

export class VirtualTradingQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualTradingQuoteError";
  }
}

function resolveExactRoute(marketId: VirtualMarketId, side: VirtualOrderSide): Route {
  const routeId = routeForVirtualOrder(marketId, side);
  const route = resolveRouteById(routeId);
  if (!route || route.id !== routeId) {
    throw new VirtualTradingQuoteError(`The ${marketId} ${side} route is unavailable.`);
  }

  const market = VIRTUAL_MARKETS[marketId];
  const expectedInput = side === "buy" ? "USDG" : market.symbol;
  const expectedOutput = side === "buy" ? market.symbol : "USDG";
  if (
    route.tokenIn.symbol !== expectedInput
    || route.tokenOut.symbol !== expectedOutput
    || (route.quote.source !== "v4" && route.quote.source !== "v4-route")
  ) {
    throw new VirtualTradingQuoteError(`The ${marketId} ${side} route does not match the virtual market.`);
  }
  return route;
}

const CANONICAL_HEAD_ATTEMPTS = 3;

/**
 * The public Robinhood RPC does not retain historical eth_call metadata, even
 * for the just-finalized block. Quote against `latest`, but accept the result
 * only when the canonical head's number and hash are unchanged before and
 * after every read. A moving head discards the entire quote and retries.
 */
async function atCanonicalHead<T>(
  publicClient: PublicClient,
  read: (block: CanonicalBlock) => Promise<T>,
): Promise<{ block: CanonicalBlock; value: T }> {
  for (let attempt = 0; attempt < CANONICAL_HEAD_ATTEMPTS; attempt += 1) {
    const before = await publicClient.getBlock({
      blockTag: "latest",
      includeTransactions: false,
    });
    if (
      before.number === null
      || before.hash === null
      || before.number <= 0n
      || before.timestamp <= 0n
    ) {
      throw new VirtualTradingQuoteError("The canonical head is missing block evidence.");
    }

    const block: CanonicalBlock = {
      number: before.number,
      hash: before.hash,
      timestamp: before.timestamp,
    };
    // Deliberately no historical block selector: this RPC serves current-state
    // eth_call only. The unchanged before/after head proves every read occurred
    // while `latest` still referred to `block`.
    const value = await read(block);
    const after = await publicClient.getBlock({
      blockTag: "latest",
      includeTransactions: false,
    });
    if (
      after.number === block.number
      && after.hash !== null
      && after.hash.toLowerCase() === block.hash.toLowerCase()
    ) {
      return { block, value };
    }
  }
  throw new VirtualTradingQuoteError("The canonical head changed during every quote attempt.");
}

function priceWad(
  sampleOutputRaw: bigint,
  sampleInputRaw: bigint,
  marketDecimals: number,
): bigint {
  const numerator =
    sampleOutputRaw
    * 10n ** BigInt(marketDecimals)
    * 10n ** BigInt(PRICE_WAD_DECIMALS);
  const denominator = sampleInputRaw * 10n ** BigInt(USDG_DECIMALS);
  const price = numerator / denominator;
  if (price <= 0n) {
    throw new VirtualTradingQuoteError("The canonical sell mark is too small to price safely.");
  }
  return price;
}

/**
 * Reference virtual marks use fixed exact-input sell samples into USDG. This
 * keeps the price cards reproducible and chain-backed. Portfolio NAV never
 * scales these samples; it uses `fetchVirtualPortfolioValuation` instead.
 */
export async function fetchVirtualMarketSnapshot(
  publicClient: PublicClient = client as PublicClient,
  quoter: RouteQuoter = quoteRoute,
  now: () => Date = () => new Date(),
): Promise<VirtualMarketSnapshot> {
  const marketIds = Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[];
  const { block, value } = await atCanonicalHead(publicClient, async () =>
    Promise.all(
      marketIds.map(async (marketId): Promise<VirtualMarketMark> => {
        const market = VIRTUAL_MARKETS[marketId];
        const route = resolveExactRoute(marketId, "sell");
        const sampleInputRaw = MARK_SAMPLE_INPUT_RAW[marketId];
        const quote = await quoter(publicClient, route, sampleInputRaw, zeroAddress);
        return {
          marketId,
          symbol: market.symbol,
          routeId: route.id,
          sampleInputRaw: sampleInputRaw.toString(),
          sampleOutputRaw: quote.amountOut.toString(),
          priceWad: priceWad(
            quote.amountOut,
            sampleInputRaw,
            market.decimals,
          ).toString(),
        };
      }),
    ),
  );

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    blockTimestamp: block.timestamp.toString(),
    readAt: now().toISOString(),
    source: "canonical Robinhood Chain head eth_call",
    markets: value,
  };
}

/** Quote one browser-local fill. This function never signs or broadcasts. */
export async function fetchVirtualFill(
  input: VirtualQuoteInput,
  publicClient: PublicClient = client as PublicClient,
  quoter: RouteQuoter = quoteRoute,
  now: () => Date = () => new Date(),
): Promise<VirtualFill> {
  if (input.inputRaw <= 0n) {
    throw new VirtualTradingQuoteError("The virtual quote input must be positive.");
  }
  const route = resolveExactRoute(input.marketId, input.side);
  const { block, value } = await atCanonicalHead(publicClient, () =>
    quoter(publicClient, route, input.inputRaw, zeroAddress),
  );
  const quotedAt = now();

  return {
    clientOrderId: input.clientOrderId,
    portfolioRevision: input.portfolioRevision,
    marketId: input.marketId,
    side: input.side,
    routeId: route.id,
    inputRaw: input.inputRaw.toString(),
    outputRaw: value.amountOut.toString(),
    gasEstimate: value.gasEstimate === null ? null : value.gasEstimate.toString(),
    chainId: ROBINHOOD_CHAIN_ID,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    blockTimestamp: block.timestamp.toString(),
    quotedAt: quotedAt.toISOString(),
    expiresAt: new Date(quotedAt.getTime() + VIRTUAL_QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * Quote the complete browser-local token portfolio into virtual USDG.
 *
 * This is deliberately separate from the reference sample marks: each positive
 * position is sent through its exact sell route at its full size, so route
 * impact is reflected in the returned USDG value. Both positions are accepted
 * only while one canonical head remains unchanged.
 */
export async function fetchVirtualPortfolioValuation(
  input: VirtualPortfolioValuationInput,
  publicClient: PublicClient = client as PublicClient,
  quoter: RouteQuoter = quoteRoute,
  now: () => Date = () => new Date(),
): Promise<VirtualPortfolioValuation> {
  if (
    input.zapsRaw < 0n
    || input.zapsRaw > MAX_UINT128
    || input.wethRaw < 0n
    || input.wethRaw > MAX_UINT128
  ) {
    throw new VirtualTradingQuoteError("Virtual positions must fit uint128.");
  }
  if (
    !Number.isSafeInteger(input.portfolioRevision)
    || input.portfolioRevision < 0
  ) {
    throw new VirtualTradingQuoteError("The portfolio revision is invalid.");
  }

  const amounts: Record<VirtualMarketId, bigint> = {
    zaps: input.zapsRaw,
    weth: input.wethRaw,
  };
  const routes: Record<VirtualMarketId, Route> = {
    zaps: resolveExactRoute("zaps", "sell"),
    weth: resolveExactRoute("weth", "sell"),
  };
  const zapsToWeth = resolveRouteById("robinhood-v4-zaps-weth");
  if (
    !zapsToWeth
    || zapsToWeth.id !== "robinhood-v4-zaps-weth"
    || zapsToWeth.tokenIn.symbol !== "0xZAPS"
    || zapsToWeth.tokenOut.symbol !== "aeWETH"
    || zapsToWeth.quote.source !== "v4"
  ) {
    throw new VirtualTradingQuoteError("The aggregate 0xZAPS to aeWETH route is unavailable.");
  }
  const { block, value } = await atCanonicalHead(publicClient, async () => {
    const standaloneZaps = amounts.zaps === 0n
      ? Promise.resolve(0n)
      : quoter(
          publicClient,
          routes.zaps,
          amounts.zaps,
          zeroAddress,
        ).then((quote) => quote.amountOut);
    const standaloneWeth = amounts.weth === 0n
      ? Promise.resolve(0n)
      : quoter(
          publicClient,
          routes.weth,
          amounts.weth,
          zeroAddress,
        ).then((quote) => quote.amountOut);
    const portfolioOutput = (async (): Promise<bigint> => {
      if (amounts.zaps === 0n) return standaloneWeth;
      const wethFromZaps = await quoter(
        publicClient,
        zapsToWeth,
        amounts.zaps,
        zeroAddress,
      );
      const combinedWeth = amounts.weth + wethFromZaps.amountOut;
      if (combinedWeth > MAX_UINT128) {
        throw new VirtualTradingQuoteError("The aggregate aeWETH exit exceeds uint128.");
      }
      if (combinedWeth === 0n) return 0n;
      const combinedQuote = await quoter(
        publicClient,
        routes.weth,
        combinedWeth,
        zeroAddress,
      );
      return combinedQuote.amountOut;
    })();
    const [zaps, weth, portfolio] = await Promise.all(
      [standaloneZaps, standaloneWeth, portfolioOutput],
    );
    return { zaps, weth, portfolio };
  });

  return {
    portfolioRevision: input.portfolioRevision,
    chainId: ROBINHOOD_CHAIN_ID,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    blockTimestamp: block.timestamp.toString(),
    readAt: now().toISOString(),
    source: "canonical Robinhood Chain head eth_call",
    positions: {
      zaps: {
        quoteKind: "standalone-full-position",
        routeId: routes.zaps.id,
        inputRaw: amounts.zaps.toString(),
        outputRaw: value.zaps.toString(),
      },
      weth: {
        quoteKind: "standalone-full-position",
        routeId: routes.weth.id,
        inputRaw: amounts.weth.toString(),
        outputRaw: value.weth.toString(),
      },
    },
    portfolioRouteIds: [
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
    ],
    portfolioOutputRaw: value.portfolio.toString(),
  };
}
