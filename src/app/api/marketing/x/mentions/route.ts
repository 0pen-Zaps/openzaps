import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { listXMentionInbox } from "@/lib/marketing/x-mentions-server";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store" } as const;
const X_ACCOUNT_ID = /^[1-9]\d{0,18}$/u;

export async function GET(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }
  const accountId = process.env.X_EXPECTED_ACCOUNT_ID;
  if (!accountId || !X_ACCOUNT_ID.test(accountId)) {
    return NextResponse.json(
      { error: "The bound X account identity is invalid." },
      { status: 503, headers: HEADERS },
    );
  }
  let result;
  try {
    result = await listXMentionInbox({ accountId, limit: 100 });
  } catch {
    return NextResponse.json(
      { error: "The durable X mention inbox is unavailable." },
      { status: 503, headers: HEADERS },
    );
  }
  return NextResponse.json(
    {
      result: result.result,
      reviewRequiredCount: result.reviewRequiredCount,
      items: result.items.map((item) => ({
        targetUrl: `https://x.com/i/web/status/${item.postId}`,
        createdAt: item.createdAt,
        classification: item.classification,
        reason: item.eligibilityReason,
        state: item.state,
        discoveredAt: item.discoveredAt,
        stateChangedAt: item.stateChangedAt,
        failureCode: item.failureCode,
      })),
      rawPostTextStored: false,
    },
    { headers: HEADERS },
  );
}
