import "server-only";

import { unstable_cache } from "next/cache";

import { TOKEN_LAUNCH } from "@/lib/config";
import { FEE_REWARDS_MANIFEST } from "@/lib/rewards";

const DEX_SCREENER_PAIR_URL =
  `https://api.dexscreener.com/latest/dex/pairs/robinhood/${TOKEN_LAUNCH.primaryPair}`;
const MAX_MARKET_NUMBER = 1_000_000_000_000_000;

export type TokenMarketPulse = {
  pair: string;
  source: "DEX Screener";
  sourceUrl: string;
  window: "rolling-24h";
  h24VolumeUsd: number;
  h24Buys: number;
  h24Sells: number;
  liquidityUsd: number | null;
  priceUsd: string | null;
  readAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedNumber(value: unknown, integer = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MARKET_NUMBER) {
    return null;
  }
  if (integer && !Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * Reduce DEX Screener's mutable response to one identity-checked market fact.
 * The endpoint is third-party market data, never protocol accounting: the UI
 * labels it as a rolling estimate and links to the exact canonical pair.
 */
export function parseTokenMarketPulse(payload: unknown, readAt = new Date().toISOString()): TokenMarketPulse {
  const root = record(payload);
  const pairs = Array.isArray(root?.pairs) ? root.pairs : [];
  const expectedPair = TOKEN_LAUNCH.primaryPair.toLowerCase();
  const expectedToken = TOKEN_LAUNCH.contract.toLowerCase();
  const expectedWeth = FEE_REWARDS_MANIFEST.weth.toLowerCase();
  const pair = pairs
    .map(record)
    .find((candidate) => (
      candidate?.chainId === "robinhood"
      && typeof candidate.pairAddress === "string"
      && candidate.pairAddress.toLowerCase() === expectedPair
    ));
  const baseToken = record(pair?.baseToken);
  const quoteToken = record(pair?.quoteToken);
  const volume = record(pair?.volume);
  const h24Transactions = record(record(pair?.txns)?.h24);
  const liquidity = record(pair?.liquidity);
  const h24VolumeUsd = boundedNumber(volume?.h24);
  const h24Buys = boundedNumber(h24Transactions?.buys, true);
  const h24Sells = boundedNumber(h24Transactions?.sells, true);
  if (
    !pair
    || typeof baseToken?.address !== "string"
    || baseToken.address.toLowerCase() !== expectedToken
    || typeof quoteToken?.address !== "string"
    || quoteToken.address.toLowerCase() !== expectedWeth
    || h24VolumeUsd === null
    || h24Buys === null
    || h24Sells === null
  ) {
    throw new Error("DEX Screener did not return the canonical 0xZAPS market");
  }
  const liquidityUsd = boundedNumber(liquidity?.usd);
  const priceUsd = typeof pair.priceUsd === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(pair.priceUsd)
    ? pair.priceUsd
    : null;
  return {
    pair: TOKEN_LAUNCH.primaryPair,
    source: "DEX Screener",
    sourceUrl: TOKEN_LAUNCH.dexscreenerUrl,
    window: "rolling-24h",
    h24VolumeUsd,
    h24Buys,
    h24Sells,
    liquidityUsd,
    priceUsd,
    readAt,
  };
}

async function fetchTokenMarketPulseUncached(): Promise<TokenMarketPulse> {
  const response = await fetch(DEX_SCREENER_PAIR_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`DEX Screener returned ${response.status}`);
  return parseTokenMarketPulse(await response.json());
}

const cachedTokenMarketPulse = unstable_cache(
  fetchTokenMarketPulseUncached,
  [
    "0xzaps-token-market-pulse-v1",
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "local",
    TOKEN_LAUNCH.primaryPair,
  ],
  { revalidate: 60, tags: ["0xzaps-token-market-pulse"] },
);

export async function fetchTokenMarketPulse(): Promise<TokenMarketPulse> {
  return cachedTokenMarketPulse();
}
