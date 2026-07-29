import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";

import { serverRateLimit } from "@/lib/relay-rate-limit";
import { relayConfigured } from "@/lib/relay-server";
import { executorScorecardPage, scorecardPageLimit } from "@/lib/scorecard-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_URL_CHARS = 2_048;
const RATE_WINDOW_MS = 10_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "Scorecard storage is not configured." }, { status: 503 });
  }
  const declaredBodyBytes = Number(request.headers.get("content-length") ?? "0");
  if (
    request.url.length > MAX_URL_CHARS
    || (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > 0)
  ) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }
  const quota = serverRateLimit(request, "executor-scorecard", 30, RATE_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } },
    );
  }
  const { address } = await params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "address must be a valid EVM address." }, { status: 400 });
  }
  try {
    const page = await executorScorecardPage(
      address,
      scorecardPageLimit(request.nextUrl.searchParams.get("limit")),
      request.nextUrl.searchParams.get("cursor"),
    );
    return NextResponse.json({ ...page, authorityScope: "none" });
  } catch (error) {
    if (
      error instanceof Error
      && (error.message.startsWith("limit must") || error.message === "Scorecard cursor is malformed.")
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Scorecard query failed." }, { status: 502 });
  }
}
