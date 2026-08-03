import { NextResponse } from "next/server";

import {
  StaleStakersSnapshotError,
  fetchFeeRewardsStakers,
} from "@/lib/rewards-stakers-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const payload = await fetchFeeRewardsStakers();
    return NextResponse.json(payload, {
      headers: {
        // The inner 30-second verified snapshot cache absorbs RPC fanout. No
        // outer CDN stale window: a stale list must fail its freshness check,
        // not get served around it.
        "cache-control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof StaleStakersSnapshotError) {
      return NextResponse.json(
        { error: "The verified staker list is refreshing." },
        {
          status: 202,
          headers: {
            "cache-control": "no-store, max-age=0",
            "retry-after": "2",
          },
        },
      );
    }
    // The list is complete or absent — an enumeration that fails any
    // accounting invariant must never surface as a shorter list of stakers.
    return NextResponse.json(
      { error: "The verified staker list is unavailable right now." },
      {
        status: 503,
        headers: { "cache-control": "no-store, max-age=0" },
      },
    );
  }
}
