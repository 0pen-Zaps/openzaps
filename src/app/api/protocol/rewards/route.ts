import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

import { serverRateLimit } from "@/lib/relay-rate-limit";
import { fetchFeeRewards } from "@/lib/rewards-server";

export const dynamic = "force-dynamic";

const VIEWER_RATE_LIMIT_MAX = 30;
const VIEWER_RATE_LIMIT_WINDOW_MS = 60_000;

function errorResponse(message: string, status: number, viewerRequest: boolean): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: {
        "cache-control": viewerRequest
          ? "private, no-store"
          : "no-store, max-age=0",
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

  if (viewer !== null) {
    const quota = serverRateLimit(
      request,
      "fee-rewards-viewer",
      VIEWER_RATE_LIMIT_MAX,
      VIEWER_RATE_LIMIT_WINDOW_MS,
    );
    if (quota.limited) {
      return NextResponse.json(
        { error: "Too many wallet reward reads. Try again shortly." },
        {
          status: 429,
          headers: {
            "cache-control": "private, no-store",
            "retry-after": String(quota.retryAfterSeconds),
          },
        },
      );
    }
  }

  try {
    const payload = await fetchFeeRewards(viewer);
    return NextResponse.json(payload, {
      headers: {
        "cache-control": viewer
          ? "private, no-store"
          // The inner 10-second verified snapshot cache absorbs RPC fanout.
          // Do not add an outer CDN stale window that can bypass its hard
          // freshness check during an RPC outage or campaign boundary.
          : "no-store, max-age=0",
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
