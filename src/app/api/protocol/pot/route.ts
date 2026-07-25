import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";

import { fetchPots } from "@/lib/pot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  // `viewer` only ever selects which address's ticket count is read back. It is
  // validated as an address so a malformed value fails here rather than inside a
  // contract call, and it never affects what the pot itself reports.
  const raw = new URL(request.url).searchParams.get("viewer");
  const viewer = raw && isAddress(raw) ? getAddress(raw) : null;

  try {
    const payload = await fetchPots(viewer);
    return NextResponse.json(payload, {
      headers: { "cache-control": viewer ? "private, no-store" : "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch {
    // Fail closed, like the activity feed: an invented prize or a zeroed ticket
    // count would both be claims about the chain that nobody verified.
    return NextResponse.json(
      { error: "Robinhood RPC reads for the lottery pot are unavailable right now." },
      { status: 503, headers: { "cache-control": "public, s-maxage=15" } },
    );
  }
}
