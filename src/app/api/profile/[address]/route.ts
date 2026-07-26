import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

import { fetchWalletProfile } from "@/lib/profile-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address: raw } = await context.params;
  if (!isAddress(raw)) {
    return NextResponse.json(
      { error: "A valid wallet address is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const profile = await fetchWalletProfile(getAddress(raw));
    return NextResponse.json(profile, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      {
        error: "Wallet activity is unavailable because the Robinhood Chain RPC read failed. No empty history was inferred.",
        sourceStatus: "unavailable",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
