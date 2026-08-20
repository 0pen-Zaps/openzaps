import { NextResponse } from "next/server";

import {
  StaleStakersSnapshotError,
  fetchFeeRewards2Stakers,
} from "@/lib/rewards-stakers-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const payload = await fetchFeeRewards2Stakers();
    return NextResponse.json(payload, {
      headers: {
        // Same posture as the campaign-1 list: the inner verified snapshot
        // cache absorbs RPC fanout; no outer CDN stale window.
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
    // Complete or absent — a failed enumeration never surfaces as a shorter
    // list of stakers.
    return NextResponse.json(
      { error: "The verified staker list is unavailable right now." },
      {
        status: 503,
        headers: { "cache-control": "no-store, max-age=0" },
      },
    );
  }
}
