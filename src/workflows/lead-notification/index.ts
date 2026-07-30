import { getWorkflowMetadata } from "workflow";

import {
  completeLeadNotificationStep,
  sendNextLeadNotificationStep,
} from "@/workflows/lead-notification/steps";

const MAX_NOTIFICATIONS_PER_RUN = 25;

export interface LeadNotificationWorkflowResult {
  processedCount: number;
  drained: boolean;
}

/**
 * Drain a bounded batch from the private lead-notification outbox.
 *
 * This workflow deliberately accepts no lead identifier or submission data.
 * Claims happen inside steps, keeping private form fields out of workflow
 * arguments and the route response.
 */
export async function openZapsLeadNotificationWorkflow(): Promise<LeadNotificationWorkflowResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  let processedCount = 0;

  for (let index = 0; index < MAX_NOTIFICATIONS_PER_RUN; index += 1) {
    const delivery = await sendNextLeadNotificationStep(workflowRunId);
    if (delivery.status === "empty") {
      return { processedCount, drained: true };
    }
    await completeLeadNotificationStep(workflowRunId, delivery);
    processedCount += 1;
  }

  return { processedCount, drained: false };
}
