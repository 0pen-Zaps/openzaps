import type { TokenMarketPulse } from "@/lib/market-server";

export const MARKET_REFRESH_MS = 60_000;
export const MARKET_MAX_AGE_MS = 5 * 60_000;
const MARKET_REQUEST_TIMEOUT_MS = 6_000;

let inflightMarketPulse: Promise<TokenMarketPulse> | null = null;

export function marketReadIsExpired(market: TokenMarketPulse, nowMs: number): boolean {
  const readMs = Date.parse(market.readAt);
  return !Number.isFinite(readMs)
    || readMs > nowMs + MARKET_REFRESH_MS
    || nowMs - readMs > MARKET_MAX_AGE_MS;
}

/**
 * One browser request for every concurrently mounted market consumer. The API
 * remains the source/cache boundary; this only prevents sibling components
 * from issuing the same request at the same moment.
 */
export function fetchTokenMarketPulseClient(): Promise<TokenMarketPulse> {
  if (inflightMarketPulse === null) {
    inflightMarketPulse = fetch("/api/protocol/market", {
      signal: AbortSignal.timeout(MARKET_REQUEST_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as TokenMarketPulse;
        if (marketReadIsExpired(data, Date.now())) throw new Error("stale market read");
        return data;
      })
      .finally(() => {
        inflightMarketPulse = null;
      });
  }
  return inflightMarketPulse;
}
