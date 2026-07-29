import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { readMarketingConfig } from "@/lib/marketing";
import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import { MarketingDraftRequestSchema } from "@/workflows/marketing-agent/contracts";
import { openZapsMarketingWorkflow } from "@/workflows/marketing-agent";

export const dynamic = "force-dynamic";
const MAX_DRAFT_REQUEST_BYTES = 24 * 1_024;

export async function POST(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, MAX_DRAFT_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof BoundedJsonBodyError ? error.status : 400;
    return NextResponse.json(
      { error: status === 413 ? "Draft request too large." : "A JSON draft request is required." },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
  const parsed = MarketingDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The draft request is invalid.", issues: parsed.error.issues },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  const config = readMarketingConfig();
  if (!config.readiness.canDraft) {
    return NextResponse.json(
      { error: "Marketing drafting is disabled or invalid.", blockers: config.readiness.blockers },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const run = await start(openZapsMarketingWorkflow, [parsed.data]);
    return NextResponse.json(
      { runId: run.runId, status: "queued" },
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Marketing workflow could not be started." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
