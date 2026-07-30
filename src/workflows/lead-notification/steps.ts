import { FatalError, RetryableError } from "workflow";

import {
  LeadNotificationEmailError,
  sendLeadNotificationEmail,
} from "@/lib/leads/notification-email";
import {
  claimNextLeadNotification,
  completeLeadNotification,
  failLeadNotification,
  LeadNotificationStoreError,
} from "@/lib/leads/notification-server";

export type SendNextLeadNotificationResult =
  | Readonly<{ status: "empty" }>
  | Readonly<{
      status: "sent";
      leadId: string;
      providerMessageId: string;
    }>;

function retryDelay(status: number | undefined): "5m" | "30s" {
  return status === 429 ? "5m" : "30s";
}

function retryableStoreError(error: unknown): boolean {
  return (
    error instanceof LeadNotificationStoreError
    && (
      error.code === "network-error"
      || (
        error.code === "rpc-error"
        && (
          error.status === 408
          || error.status === 409
          || error.status === 429
          || (typeof error.status === "number" && error.status >= 500)
        )
      )
    )
  );
}

function throwStoreFailure(
  error: unknown,
  operation: "claim" | "completion" | "failure recording",
): never {
  if (retryableStoreError(error)) {
    const status =
      error instanceof LeadNotificationStoreError ? error.status : undefined;
    throw new RetryableError(
      `Lead notification ${operation} is temporarily unavailable.`,
      { retryAfter: retryDelay(status) },
    );
  }
  throw new FatalError(`Lead notification ${operation} failed closed.`);
}

function permanentFailureCode(
  error: LeadNotificationEmailError,
): string {
  if (error.code === "invalid-input") return "invalid_email_input";
  if (error.code === "invalid-response") {
    return "provider_invalid_response";
  }
  if (error.code === "provider-error") return "provider_rejected";
  return "provider_unreachable";
}

async function recordPermanentFailure(
  leadId: string,
  workerId: string,
  error: LeadNotificationEmailError,
): Promise<never> {
  let result;
  try {
    result = await failLeadNotification(
      leadId,
      workerId,
      permanentFailureCode(error),
      true,
    );
  } catch (storeError) {
    throwStoreFailure(storeError, "failure recording");
  }
  if (result !== "permanent_failure") {
    throw new FatalError(
      "Lead notification failure recording lost ownership.",
    );
  }
  throw new FatalError("Lead notification delivery was permanently rejected.");
}

/**
 * Claim and send one lead notification.
 *
 * The provider write and its stable idempotency key live in this one retryable
 * step. Database completion is deliberately a separate step so a transient
 * completion failure cannot replay the provider write.
 */
export async function sendNextLeadNotificationStep(
  workerId: string,
): Promise<SendNextLeadNotificationResult> {
  "use step";

  let claim;
  try {
    claim = await claimNextLeadNotification(workerId);
  } catch (error) {
    throwStoreFailure(error, "claim");
  }
  if (claim === null) return { status: "empty" };

  try {
    const providerMessageId = await sendLeadNotificationEmail(claim);
    return {
      status: "sent",
      leadId: claim.lead_id,
      providerMessageId,
    };
  } catch (error) {
    if (error instanceof LeadNotificationEmailError) {
      if (error.retryable || error.code === "not-configured") {
        throw new RetryableError(
          "Lead notification provider is temporarily unavailable.",
          { retryAfter: retryDelay(error.status) },
        );
      }
      return recordPermanentFailure(claim.lead_id, workerId, error);
    }
    throw new RetryableError(
      "Lead notification provider is temporarily unavailable.",
      { retryAfter: "30s" },
    );
  }
}
sendNextLeadNotificationStep.maxRetries = 5;

export async function completeLeadNotificationStep(
  workerId: string,
  delivery: Readonly<{
    leadId: string;
    providerMessageId: string;
  }>,
): Promise<void> {
  "use step";

  let result;
  try {
    result = await completeLeadNotification(
      delivery.leadId,
      workerId,
      delivery.providerMessageId,
    );
  } catch (error) {
    throwStoreFailure(error, "completion");
  }
  if (result === "sent" || result === "already_sent") return;
  throw new FatalError("Lead notification completion lost ownership.");
}
completeLeadNotificationStep.maxRetries = 5;
