import { NextResponse } from "next/server";
import { getRun } from "workflow/api";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import {
  MarketingRunEventSchema,
  MarketingWorkflowResultSchema,
  type MarketingApprovalPayload,
  type MarketingDraftBundle,
  type MarketingRunEvent,
  type MarketingWorkflowResult,
} from "@/workflows/marketing-agent/contracts";

export const dynamic = "force-dynamic";
const MAX_MARKETING_RUN_EVENTS = 8;

function validRunId(runId: string): boolean {
  return runId.length >= 1 && runId.length <= 200 && !/[\s/\\]/u.test(runId);
}

interface MarketingRunSnapshot {
  latest: MarketingRunEvent | null;
  draft?: MarketingDraftBundle;
  approval?: MarketingApprovalPayload;
  result?: MarketingWorkflowResult;
}

async function marketingRunSnapshot(
  run: ReturnType<typeof getRun<MarketingWorkflowResult>>,
): Promise<MarketingRunSnapshot> {
  const readable = run.getReadable<unknown>({ startIndex: 0 });
  const tailIndex = await readable.getTailIndex();
  if (tailIndex < 0) return { latest: null };
  if (tailIndex >= MAX_MARKETING_RUN_EVENTS) {
    throw new Error("Marketing workflow emitted too many events.");
  }

  const reader = readable.getReader();
  const snapshot: MarketingRunSnapshot = { latest: null };
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      const parsed = MarketingRunEventSchema.safeParse(next.value);
      if (!parsed.success) continue;

      const event = parsed.data;
      snapshot.latest = event;
      if (event.type === "draft") snapshot.draft = event.draft;
      if (event.type === "approval") snapshot.approval = event.approval;
      if (event.type === "result") {
        snapshot.result = event.result;
        snapshot.draft = event.result.draft;
        if (event.result.approval) snapshot.approval = event.result.approval;
      }
    }
    return snapshot;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }
  const { runId } = await params;
  if (!validRunId(runId)) {
    return NextResponse.json(
      { error: "Invalid workflow run id." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const run = getRun<MarketingWorkflowResult>(runId);
    if (!(await run.exists)) {
      return NextResponse.json(
        { error: "Workflow run not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    }

    const workflowStatus = await run.status;
    const snapshot = await marketingRunSnapshot(run);
    const event = snapshot.latest;
    let result: MarketingWorkflowResult | undefined;
    if (workflowStatus === "completed") {
      const parsed = MarketingWorkflowResultSchema.safeParse(await run.returnValue);
      if (parsed.success) result = parsed.data;
    }
    result ??= snapshot.result;
    const draft = result?.draft ?? snapshot.draft;
    const eventStatus =
      event?.type === "draft"
        ? event.state
        : event?.type === "approval"
          ? event.state
          : event?.type === "result"
            ? event.result.status
            : null;
    const terminalWorkflowStatus = ["completed", "failed", "cancelled", "canceled"].includes(
      workflowStatus,
    )
      ? workflowStatus
      : null;
    const status = result?.status ?? terminalWorkflowStatus ?? eventStatus ?? workflowStatus;

    return NextResponse.json(
      {
        run: {
          runId,
          status,
          workflowStatus,
          ...(draft ? { draft } : {}),
          ...(result?.approval || snapshot.approval
            ? { approval: result?.approval ?? snapshot.approval }
            : {}),
          ...(result ? { result } : {}),
        },
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Workflow status is unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
