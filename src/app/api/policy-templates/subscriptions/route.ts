import { NextResponse, type NextRequest } from "next/server";

import { callerKey, createRateLimit } from "@/lib/rate-limit";
import {
  getPolicyTemplate,
  getPolicyTemplateSubscriptionSnapshot,
  PolicyTemplateSubscriptionAdmissionError,
  policyRegistryConfigured,
  policyTemplateSubscriptionsEnabled,
  setPolicyTemplateSubscription,
  verifyPolicyTemplateSubscriber,
  verifyPolicyTemplateSubscriberRead,
} from "@/lib/policy-template-server";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateLimited = createRateLimit(30, 60_000);
const MAX_BODY_BYTES = 2_048;
const PRIVATE_NO_STORE = { "cache-control": "private, no-store, max-age=0" };

function privateJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!policyTemplateSubscriptionsEnabled()) {
    return privateJson({
      error: "Public template subscriptions are disabled on this deployment.",
      code: "SUBSCRIPTIONS_DISABLED",
    }, 503);
  }
  if (!policyRegistryConfigured()) {
    return privateJson({ error: "The public policy registry is not configured." }, 503);
  }
  if (rateLimited(callerKey(request))) {
    return privateJson({ error: "Too many requests." }, 429);
  }

  let body: {
    operation?: unknown;
    subscriber?: unknown;
    subscriberSignature?: unknown;
    requestNonce?: unknown;
    contentHash?: unknown;
    subscribed?: unknown;
    expectedVersion?: unknown;
    expiresAt?: unknown;
  };
  try {
    const raw = await readBoundedJsonBody(request, MAX_BODY_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return privateJson({ error: "Body must be a JSON object." }, 400);
    }
    body = raw as typeof body;
  } catch (error) {
    if (error instanceof BoundedJsonBodyError && error.status === 413) {
      return privateJson({ error: "Body too large." }, 413);
    }
    return privateJson({ error: "Body must be valid JSON." }, 400);
  }

  try {
    if (body.operation === "read") {
      const admission = await verifyPolicyTemplateSubscriberRead(
        body.subscriber,
        body.requestNonce,
        body.expiresAt,
        body.subscriberSignature,
      );
      const snapshot = await getPolicyTemplateSubscriptionSnapshot(
        admission.subscriber,
        admission.subscriberKey,
      );
      return privateJson(snapshot);
    }
    if (body.operation !== "set") {
      throw new PolicyTemplateSubscriptionAdmissionError(
        "Subscription operation must be read or set.",
        "INVALID_ACTION",
      );
    }
    const admission = await verifyPolicyTemplateSubscriber(
      body.subscriber,
      body.contentHash,
      body.subscribed,
      body.expectedVersion,
      body.expiresAt,
      body.subscriberSignature,
    );
    if (admission.subscribed && !(await getPolicyTemplate(String(body.contentHash)))) {
      return privateJson({ error: "That exact template version does not exist." }, 404);
    }
    const mutation = await setPolicyTemplateSubscription(
      admission.subscriberKey,
      String(body.contentHash),
      admission.subscribed,
      admission.expectedVersion,
      admission.expiresAt,
    );
    return privateJson({
      contentHash: String(body.contentHash).toLowerCase(),
      subscribed: mutation.subscribed,
      subscriber: admission.subscriber,
      version: mutation.version,
    });
  } catch (cause) {
    if (cause instanceof PolicyTemplateSubscriptionAdmissionError) {
      return privateJson({
        error: cause.message,
        code: cause.code,
        ...(cause.currentVersion === undefined ? {} : { currentVersion: cause.currentVersion }),
      }, cause.status);
    }
    return privateJson({ error: "Policy subscription write failed." }, 502);
  }
}
