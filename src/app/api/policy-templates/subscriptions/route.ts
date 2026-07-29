import { NextResponse, type NextRequest } from "next/server";

import { callerKey, createRateLimit } from "@/lib/rate-limit";
import {
  getPolicyTemplate,
  isSubscriberKey,
  policyRegistryConfigured,
  policyTemplateSubscriptionsEnabled,
  setPolicyTemplateSubscription,
} from "@/lib/policy-template-server";
import { isPolicyTemplateHash } from "@/lib/policy-templates";

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

  let body: { subscriberKey?: unknown; contentHash?: unknown; subscribed?: unknown };
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Body too large." }, { status: 413 });
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Body too large." }, { status: 413 });
    }
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  if (
    !isSubscriberKey(body.subscriberKey)
    || !isPolicyTemplateHash(body.contentHash)
    || typeof body.subscribed !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid exact-version subscription." }, { status: 422 });
  }

  try {
    if (!(await getPolicyTemplate(body.contentHash))) {
      return NextResponse.json({ error: "That exact template version does not exist." }, { status: 404 });
    }
    await setPolicyTemplateSubscription(body.subscriberKey, body.contentHash, body.subscribed);
    return NextResponse.json({ contentHash: body.contentHash.toLowerCase(), subscribed: body.subscribed });
  } catch {
    return NextResponse.json({ error: "Policy subscription write failed." }, { status: 502 });
  }
}
