import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

import { fetchWalletPortfolio } from "@/lib/profile-portfolio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address: raw } = await context.params;
  if (!isAddress(raw, { strict: false })) {
    return NextResponse.json(
      { error: "A valid wallet address is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const portfolio = await fetchWalletPortfolio(getAddress(raw));
    return NextResponse.json(portfolio, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      {
        error: "Wallet holdings are unavailable because the Robinhood Chain RPC head or balance read failed. No zero portfolio was inferred.",
        sourceStatus: "unavailable",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
