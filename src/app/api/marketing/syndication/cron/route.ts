import { NextResponse } from "next/server";

import { isCronAuthorized } from "@/lib/cron-auth";
import {
  discoverMarketingSyndication,
  marketingSyndicationConfigured,
} from "@/lib/marketing/syndication-server";

export const dynamic = "force-dynamic";
const HEADERS = { "cache-control": "private, no-store" } as const;

/**
 * Read-only public-feed discovery plus durable inbox writes. This route never
 * starts a workflow and never imports an X, Discord, or Substack write adapter.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: HEADERS },
    );
  }
  if (!marketingSyndicationConfigured()) {
    return NextResponse.json(
      { error: "The durable marketing syndication inbox is not configured." },
      { status: 503, headers: HEADERS },
    );
  }
  try {
    const discovery = await discoverMarketingSyndication();
    return NextResponse.json(discovery, { headers: HEADERS });
  } catch {
    return NextResponse.json(
      {
        error:
          "Syndication discovery could not be completed; no publishing workflow was started.",
      },
      { status: 503, headers: HEADERS },
    );
  }
}
