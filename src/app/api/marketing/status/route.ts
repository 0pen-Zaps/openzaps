import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminTokenConfigured,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { readMarketingConfig } from "@/lib/marketing";
import { listSourceControlledTutorialSelections } from "@/lib/marketing/tutorial-handoff-source";
import { readXMentionAutomationConfig } from "@/lib/marketing/x-mentions";
import {
  getMarketingXComplianceHealth,
  marketingXComplianceConfigured,
  type XComplianceHealth,
} from "@/lib/marketing/x-compliance-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  const config = readMarketingConfig();
  const accountId = process.env.X_EXPECTED_ACCOUNT_ID;
  let xComplianceHealth: XComplianceHealth | null = null;
  if (
    accountId
    && /^[1-9][0-9]{0,18}$/u.test(accountId)
    && marketingXComplianceConfigured()
  ) {
    try {
      xComplianceHealth = await getMarketingXComplianceHealth(accountId);
    } catch {
      // Readiness stays fail-closed and reports an unavailable checkpoint.
    }
  }
  const xMentionAutomation = readXMentionAutomationConfig(
    process.env,
    xComplianceHealth,
  );
  return NextResponse.json(
    {
      service: "OpenZaps marketing agent",
      config,
      xMentionAutomation,
      xComplianceHealth: xComplianceHealth
        ? {
            result: xComplianceHealth.result,
            checkedAt: xComplianceHealth.checkedAt,
            validUntil: xComplianceHealth.validUntil,
            subjectCount: xComplianceHealth.subjectCount,
            nonPresentCount: xComplianceHealth.nonPresentCount,
            hold: xComplianceHealth.hold,
          }
        : null,
      sourceControlledTutorials: listSourceControlledTutorialSelections(),
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
