import { NextResponse } from "next/server";

import { serverRateLimit } from "@/lib/relay-rate-limit";
import { fetchCampaign2Preflight } from "@/lib/rewards2-server";

export const dynamic = "force-dynamic";

const PREFLIGHT_RATE_LIMIT_MAX = 30;
const PREFLIGHT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Campaign-2 operator preflight: one block-pinned snapshot of the runbook
 * preconditions (and, once released, both legs' live state). All-or-nothing:
 * a failed read is an explicit 503, never a zeroed payload.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const quota = serverRateLimit(
    request,
    "campaign2-preflight",
    PREFLIGHT_RATE_LIMIT_MAX,
    PREFLIGHT_RATE_LIMIT_WINDOW_MS,
  );
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many preflight reads. Try again shortly." },
      { status: 429, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }

  try {
    const payload = await fetchCampaign2Preflight();
    return NextResponse.json(payload, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json(
      { error: "The campaign-2 preflight snapshot is unavailable right now." },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
