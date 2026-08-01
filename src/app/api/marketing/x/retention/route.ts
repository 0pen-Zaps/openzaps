import { NextResponse } from "next/server";

import { isCronAuthorized } from "@/lib/cron-auth";
import {
  marketingXComplianceConfigured,
  purgeMarketingXRetention,
} from "@/lib/marketing/x-compliance-server";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: HEADERS },
    );
  }
  if (!marketingXComplianceConfigured()) {
    return NextResponse.json(
      { error: "X retention is not ready." },
      { status: 503, headers: HEADERS },
    );
  }
  try {
    const result = await purgeMarketingXRetention();
    return NextResponse.json(
      {
        purged: true,
        expiredSubjectCount: result.expiredSubjectCount,
        deletedMentionCount: result.deletedMentionCount,
        deletedOptOutCount: result.deletedOptOutCount,
        deletedAdmissionCount: result.deletedAdmissionCount,
        deletedCheckpointCount: result.deletedCheckpointCount,
        deletedComplianceEventCount: result.deletedComplianceEventCount,
        resetCursorCount: result.resetCursorCount,
        processedAt: result.processedAt,
      },
      { headers: HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: "X retention failed closed." },
      { status: 503, headers: HEADERS },
    );
  }
}
