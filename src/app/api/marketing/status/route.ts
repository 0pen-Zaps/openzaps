import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminTokenConfigured,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { readMarketingConfig } from "@/lib/marketing";
import { readXMentionAutomationConfig } from "@/lib/marketing/x-mentions";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  const config = readMarketingConfig();
  const xMentionAutomation = readXMentionAutomationConfig();
  return NextResponse.json(
    {
      service: "OpenZaps marketing agent",
      config,
      xMentionAutomation,
      operatorAuthConfigured: marketingAdminTokenConfigured(),
      model: process.env.OPENZAPS_MARKETING_MODEL?.trim() || "openai/gpt-5-mini",
      workflow: "vercel-workflow",
      policy: {
        allOutboundInitiallyReviewed: !config.autoPublish,
        xAiRepliesApproved: config.xAiReplyApproved,
        xReplyScope:
          "operator-selected canonical status URLs; API-verified mentions or owned quotes only; one human-approved reply per interaction",
        xAutomaticReplyScope:
          "official mentions timeline only; exact reviewed deterministic commands; first-run baseline; one reply per interaction; opt-out; all other content remains review-only",
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
