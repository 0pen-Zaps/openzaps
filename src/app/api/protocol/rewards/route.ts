import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

import { fetchFeeRewards } from "@/lib/rewards-server";

export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number, viewerRequest: boolean): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: {
        "cache-control": viewerRequest
          ? "private, no-store"
          : "public, s-maxage=5, stale-while-revalidate=15",
      },
    },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const rawViewer = new URL(request.url).searchParams.get("viewer");
  if (rawViewer !== null && !isAddress(rawViewer)) {
    return errorResponse("viewer must be a valid EVM address.", 400, true);
  }
  const viewer = rawViewer === null ? null : getAddress(rawViewer);

  try {
    const payload = await fetchFeeRewards(viewer);
    return NextResponse.json(payload, {
      headers: {
        "cache-control": viewer
          ? "private, no-store"
          : "public, s-maxage=20, stale-while-revalidate=60",
      },
    });
  } catch {
    // Every surfaced number belongs to one all-or-nothing canonical snapshot.
    // Never turn a failed contract call, runtime mismatch, or reorg into zero.
    return errorResponse(
      "Verified Robinhood fee-reward reads are unavailable right now.",
      503,
      viewer !== null,
    );
  }
}
