import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { verifyDiscordPublishDestination } from "@/lib/marketing/channels/discord";
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
    const destination = await verifyDiscordPublishDestination();
    return NextResponse.json(
      {
        service: "OpenZaps Discord activation preflight",
        destination,
        commandReadback: "not_checked",
        writesPerformed: false,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const headers = new Headers({ "cache-control": "private, no-store" });
    const retryAfter = boundedRetryAfter(error);
    if (retryAfter) headers.set("retry-after", retryAfter);
    return NextResponse.json(
      {
        error: "Discord destination could not be verified.",
        destination: { verified: false },
        commandReadback: "not_checked",
        writesPerformed: false,
      },
      { status: 503, headers },
    );
  }
}
