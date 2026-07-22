import { NextResponse } from "next/server";

import { fetchProtocolActivity } from "@/lib/activity-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const payload = await fetchProtocolActivity();
    return NextResponse.json(payload, {
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch {
    // Fail closed: the dashboard shows an honest unavailable state instead of
    // fabricated rows or zero-count stats that read as "no activity". The
    // short error cache lets the CDN absorb client retry polls while the RPC
    // is down instead of amplifying them.
    return NextResponse.json(
      { error: "Robinhood RPC log queries are unavailable right now." },
      { status: 503, headers: { "cache-control": "public, s-maxage=15" } },
    );
  }
}
