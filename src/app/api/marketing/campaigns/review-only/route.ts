import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import {
  availableReviewOnlyMarketingCampaigns,
} from "@/lib/marketing/scheduled-template";

export const dynamic = "force-dynamic";

const NO_EXTERNAL_ACTION = {
  ownerReviewRequired: true,
  automaticQueueEligible: false,
  workflowsStarted: false,
  providerWritesAttempted: false,
  writesPerformed: false,
} as const;

export async function GET(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  const evaluatedAt = new Date().toISOString();
  try {
    const campaigns = availableReviewOnlyMarketingCampaigns(evaluatedAt);
    return NextResponse.json(
      {
        schemaVersion: 1,
        service: "OpenZaps review-only campaign artifacts",
        evaluatedAt,
        campaigns,
        ...NO_EXTERNAL_ACTION,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        error: "Review-only campaign artifacts could not be loaded.",
        ...NO_EXTERNAL_ACTION,
      },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
