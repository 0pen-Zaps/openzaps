import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminTokenConfigured,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { readMarketingConfig } from "@/lib/marketing";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  const config = readMarketingConfig();
  return NextResponse.json(
    {
      service: "OpenZaps marketing agent",
      config,
      operatorAuthConfigured: marketingAdminTokenConfigured(),
      model: process.env.OPENZAPS_MARKETING_MODEL?.trim() || "openai/gpt-5-mini",
      workflow: "vercel-workflow",
      policy: {
        allOutboundInitiallyReviewed: !config.autoPublish,
        xAiRepliesApproved: config.xAiReplyApproved,
        xReplyScope:
          "operator-selected canonical status URLs; API-verified mentions or owned quotes only; one human-approved reply per interaction",
        xAutomatedLabelConfirmed: config.xAutomatedLabelConfirmed,
        substack: "human editor handoff only; no private or undocumented write API",
        directMessages: "hard-disabled in this release; no adapter is deployed",
      },
    },
    {
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}
