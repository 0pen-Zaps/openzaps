import { NextResponse } from "next/server";

import { fetchTokenMarketPulse } from "@/lib/market-server";

export const dynamic = "force-dynamic";

/** Third-party rolling market data for the exact canonical 0xZAPS pool. */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await fetchTokenMarketPulse(), {
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=90" },
    });
  } catch {
    return NextResponse.json(
      { error: "The canonical 0xZAPS market pulse is unavailable right now." },
      {
        status: 503,
        headers: {
          "cache-control": "public, s-maxage=10",
          "retry-after": "10",
        },
      },
    );
  }
}
