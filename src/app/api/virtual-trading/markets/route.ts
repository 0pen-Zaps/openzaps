import { NextRequest, NextResponse } from "next/server";

import { serverRateLimit } from "@/lib/relay-rate-limit";
import { fetchVirtualMarketSnapshot } from "@/lib/virtual-trading-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUCCESS_CACHE = "public, s-maxage=15, stale-while-revalidate=30";
const ERROR_CACHE = "public, s-maxage=5";
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(
    request,
    "virtual-trading-markets",
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many virtual market requests. Try again shortly." },
      {
        status: 429,
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "retry-after": String(quota.retryAfterSeconds),
        },
      },
    );
  }

  try {
    const snapshot = await fetchVirtualMarketSnapshot();
    return NextResponse.json(snapshot, {
      headers: { "cache-control": SUCCESS_CACHE },
    });
  } catch {
    return NextResponse.json(
      { error: "Canonical virtual market marks are temporarily unavailable." },
      {
        status: 503,
        headers: { "cache-control": ERROR_CACHE },
      },
    );
  }
}
