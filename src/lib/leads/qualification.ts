import type { LeadRequest } from "@/lib/leads/schema";

/**
 * A transparent five-signal score for prioritising human follow-up.
 *
 * One point each: identifiable project, concrete workflow, named protocols or
 * assets, explicit safety limits, and intent to test within 30 days.
 */
export function qualificationScore(
  lead: Pick<
    LeadRequest,
    | "project"
    | "projectUrl"
    | "workflow"
    | "protocolsAssets"
    | "guardrails"
    | "timeline"
  >,
): number {
  return [
    Boolean(lead.project || lead.projectUrl),
    lead.workflow.length >= 80,
    Boolean(lead.protocolsAssets && lead.protocolsAssets.length >= 3),
    lead.guardrails.length >= 20,
    lead.timeline === "immediately" || lead.timeline === "within_30_days",
  ].filter(Boolean).length;
}
