import { defineHook, getWorkflowMetadata } from "workflow";

import {
  MarketingApprovalPayloadSchema,
  type MarketingApprovalPayload,
  type MarketingDelivery,
  type MarketingDraftRequest,
  type MarketingRunEvent,
  type MarketingWorkflowResult,
} from "@/workflows/marketing-agent/contracts";
import {
  closeMarketingRunStreamStep,
  collectMarketingSourcesStep,
  completeMarketingResultStep,
  emitMarketingRunEventStep,
  generateMarketingDraftStep,
  notifyMarketingReviewStep,
  publishMarketingBundleStep,
} from "@/workflows/marketing-agent/steps";

export const marketingApprovalHook = defineHook({
  schema: MarketingApprovalPayloadSchema,
});

export function marketingApprovalToken(runId: string): string {
  if (!runId || runId.length > 200 || /[\s/\\]/u.test(runId)) {
    throw new Error("Invalid marketing workflow run id.");
  }
  return `openzaps:marketing:approval:${runId}`;
}

function dispositionState(
  dispositions: readonly string[],
): "awaiting_approval" | "blocked" | "dry_run_complete" {
  if (dispositions.some((value) => value === "blocked" || value === "prohibited")) {
    return "blocked";
  }
  if (dispositions.every((value) => value === "dry_run")) return "dry_run_complete";
  return "awaiting_approval";
}

/**
 * Summarize delivery receipts without erasing pending handoffs or partial
 * provider success. A top-level `published` result means every candidate was
 * actually published by its provider.
 */
export function marketingDeliveryResultStatus(
  deliveries: readonly MarketingDelivery[],
): MarketingWorkflowResult["status"] {
  if (deliveries.length === 0) return "failed";
  if (deliveries.every((delivery) => delivery.status === "dry_run")) {
    return "dry_run_complete";
  }
  if (deliveries.every((delivery) => delivery.status === "published")) {
    return "published";
  }
  if (deliveries.every((delivery) => delivery.status === "requires_human_publish")) {
    return "requires_human_publish";
  }
  if (deliveries.every((delivery) => delivery.status === "failed")) {
    return "failed";
  }
  if (deliveries.every((delivery) => delivery.status === "blocked")) {
    return "blocked";
  }
  if (deliveries.some((delivery) => delivery.status === "published")) {
    return "partially_published";
  }
  return "completed_with_errors";
}

async function emit(event: MarketingRunEvent): Promise<void> {
  await emitMarketingRunEventStep(event);
}

export async function openZapsMarketingWorkflow(
  request: MarketingDraftRequest,
): Promise<MarketingWorkflowResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const sourcePacket = await collectMarketingSourcesStep(request);
  const draft = await generateMarketingDraftStep(request, sourcePacket, workflowRunId);
  const state = dispositionState(draft.policy.map((decision) => decision.disposition));

  await emit({
    type: "draft",
    at: new Date().toISOString(),
    state,
    draft,
  });

  if (state === "blocked" || state === "dry_run_complete") {
    const result = await completeMarketingResultStep({
      runId: workflowRunId,
      status: state,
      draft,
      approval: null,
      deliveries: draft.candidates.map((candidate) => ({
        channel: candidate.channel,
        candidateId: candidate.id,
        status: state === "blocked" ? "blocked" : "dry_run",
        idempotencyKey: `${draft.id}:${candidate.channel}`,
        ...(state === "blocked"
          ? { error: "Deterministic pre-publication policy blocked this draft." }
          : {}),
      })),
    });
    await emit({ type: "result", at: new Date().toISOString(), result });
    await closeMarketingRunStreamStep();
    return result;
  }

  using approvalHook = marketingApprovalHook.create({
    token: marketingApprovalToken(workflowRunId),
  });
  try {
    await notifyMarketingReviewStep(draft);
  } catch {
    // Review notification is advisory. The durable hook and private operator
    // surface remain the approval boundary when Discord is unavailable.
  }
  const approval: MarketingApprovalPayload = await approvalHook;
  await emit({
    type: "approval",
    at: new Date().toISOString(),
    state: approval.decision === "approve" ? "approved" : "rejected",
    approval,
  });

  if (approval.decision === "reject") {
    const result = await completeMarketingResultStep({
      runId: workflowRunId,
      status: "rejected",
      draft,
      approval,
      deliveries: [],
    });
    await emit({ type: "result", at: new Date().toISOString(), result });
    await closeMarketingRunStreamStep();
    return result;
  }

  const deliveries = await publishMarketingBundleStep(draft, approval);
  const status = marketingDeliveryResultStatus(deliveries);
  const result = await completeMarketingResultStep({
    runId: workflowRunId,
    status,
    draft,
    approval,
    deliveries,
  });
  await emit({ type: "result", at: new Date().toISOString(), result });
  await closeMarketingRunStreamStep();
  return result;
}

export type {
  MarketingApprovalPayload,
  MarketingDraftRequest,
  MarketingRunEvent,
  MarketingWorkflowResult,
} from "@/workflows/marketing-agent/contracts";
