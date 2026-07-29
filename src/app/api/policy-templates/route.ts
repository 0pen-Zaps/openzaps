import { NextResponse, type NextRequest } from "next/server";

import { callerKey, createRateLimit } from "@/lib/rate-limit";
import {
  getPolicyTemplate,
  insertPolicyTemplate,
  listPolicyTemplates,
  policyRegistryConfigured,
  policyTemplatePublishingEnabled,
  policyTemplateSubscriptionsEnabled,
  verifyPolicyTemplatePublisher,
} from "@/lib/policy-template-server";
import { preparePolicyTemplate } from "@/lib/policy-templates";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_768;
const rateLimited = createRateLimit(12, 60_000);

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!policyRegistryConfigured()) {
    return NextResponse.json({
      configured: false,
      publishingEnabled: policyTemplatePublishingEnabled(),
      subscriptionsEnabled: policyTemplateSubscriptionsEnabled(),
      templates: [],
      nextCursor: null,
    });
  }
  if (rateLimited(callerKey(request))) {
    return NextResponse.json({ configured: true, templates: [], error: "Too many requests." }, { status: 429 });
  }
  try {
    const cursor = request.nextUrl.searchParams.get("cursor");
    const page = await listPolicyTemplates(24, cursor);
    return NextResponse.json({
      configured: true,
      publishingEnabled: policyTemplatePublishingEnabled(),
      subscriptionsEnabled: policyTemplateSubscriptionsEnabled(),
      ...page,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Invalid policy registry cursor.") {
      return NextResponse.json(
        {
          configured: true,
          publishingEnabled: policyTemplatePublishingEnabled(),
          subscriptionsEnabled: policyTemplateSubscriptionsEnabled(),
          templates: [],
          nextCursor: null,
          error: cause.message,
        },
        { status: 400 },
      );
    }
    return NextResponse.json({
      configured: true,
      publishingEnabled: policyTemplatePublishingEnabled(),
      subscriptionsEnabled: policyTemplateSubscriptionsEnabled(),
      templates: [],
      nextCursor: null,
      error: "Policy registry read failed.",
    }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!policyTemplatePublishingEnabled()) {
    return NextResponse.json(
      {
        error: "Public template publishing is disabled on this deployment. Read-only browsing remains available.",
        code: "PUBLISHING_DISABLED",
      },
      { status: 503 },
    );
  }
  if (!policyRegistryConfigured()) {
    return NextResponse.json({ error: "The public policy registry is not configured on this deployment." }, { status: 503 });
  }
  if (rateLimited(callerKey(request))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedJsonBodyError && error.status === 413) {
      return NextResponse.json({ error: "Body too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  try {
    const prepared = preparePolicyTemplate(raw);
    const row = raw as Record<string, unknown>;
    const admission = await verifyPolicyTemplatePublisher(
      prepared,
      row.publisher,
      row.publisherSignature,
    );
    if (prepared.parentHash) {
      const parent = await getPolicyTemplate(prepared.parentHash);
      if (!parent) return NextResponse.json({ error: "Parent template was not found." }, { status: 409 });
      if (prepared.version !== parent.version + 1) {
        return NextResponse.json(
          { error: `A fork of version ${parent.version} must publish as version ${parent.version + 1}.` },
          { status: 409 },
        );
      }
    }
    const template = await insertPolicyTemplate(prepared, admission);
    return NextResponse.json({ template }, { status: 201 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Template could not be published.";
    const validation = !message.startsWith("Policy registry");
    return NextResponse.json({ error: message }, { status: validation ? 422 : 502 });
  }
}
