import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { verifyXAuthenticatedIdentity } from "@/lib/marketing/channels/x";
import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

export const dynamic = "force-dynamic";

function boundedRetryAfter(error: unknown): string | null {
  if (!(error instanceof ChannelAdapterError)) return null;
  const retryAfterMs = error.details.retryAfterMs;
  if (
    typeof retryAfterMs !== "number"
    || !Number.isSafeInteger(retryAfterMs)
    || retryAfterMs <= 0
  ) {
    return null;
  }
  return String(Math.min(86_400, Math.ceil(retryAfterMs / 1_000)));
}

export async function GET(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  try {
    const identity = await verifyXAuthenticatedIdentity();
    return NextResponse.json(identity, {
      headers: {
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const headers = new Headers({
      "cache-control": "private, no-store",
    });
    const retryAfter = boundedRetryAfter(error);
    if (retryAfter) headers.set("retry-after", retryAfter);
    return NextResponse.json(
      { error: "X identity could not be verified." },
      {
        status: 503,
        headers,
      },
    );
  }
}
