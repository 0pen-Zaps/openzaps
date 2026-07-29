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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!policyTemplateSubscriptionsEnabled()) {
    return NextResponse.json(
      {
        error: "Public template subscriptions are disabled on this deployment.",
        code: "SUBSCRIPTIONS_DISABLED",
      },
      { status: 503 },
    );
  }
  if (!policyRegistryConfigured()) {
    return NextResponse.json({ error: "The public policy registry is not configured." }, { status: 503 });
  }
  if (rateLimited(callerKey(request))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
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
      return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
    }
    body = raw as typeof body;
  } catch (error) {
    if (error instanceof BoundedJsonBodyError && error.status === 413) {
      return NextResponse.json({ error: "Body too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
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
      return NextResponse.json(snapshot, {
        headers: { "cache-control": "private, no-store, max-age=0" },
      });
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
      return NextResponse.json({ error: "That exact template version does not exist." }, { status: 404 });
    }
    const mutation = await setPolicyTemplateSubscription(
      admission.subscriberKey,
      String(body.contentHash),
      admission.subscribed,
      admission.expectedVersion,
      admission.expiresAt,
    );
    return NextResponse.json({
      contentHash: String(body.contentHash).toLowerCase(),
      subscribed: mutation.subscribed,
      subscriber: admission.subscriber,
      version: mutation.version,
    }, {
      headers: { "cache-control": "private, no-store, max-age=0" },
    });
  } catch (cause) {
    if (cause instanceof PolicyTemplateSubscriptionAdmissionError) {
      return NextResponse.json({
        error: cause.message,
        code: cause.code,
        ...(cause.currentVersion === undefined ? {} : { currentVersion: cause.currentVersion }),
      }, { status: cause.status });
    }
    return NextResponse.json({ error: "Policy subscription write failed." }, { status: 502 });
  }
}
