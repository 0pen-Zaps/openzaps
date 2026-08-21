import { NextResponse } from "next/server";

import { serverRateLimit } from "@/lib/relay-rate-limit";
import { fetchCampaign2StakingPulse } from "@/lib/rewards2-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const quota = serverRateLimit(request, "campaign2-staking-pulse", 60, 60_000);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many campaign staking reads. Try again shortly." },
      {
        status: 429,
        headers: {
          "cache-control": "no-store, max-age=0",
          "retry-after": String(quota.retryAfterSeconds),
        },
      },
    );
  }
  try {
    return NextResponse.json(await fetchCampaign2StakingPulse(), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json(
      { error: "The campaign-2 staking snapshot is unavailable right now." },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
