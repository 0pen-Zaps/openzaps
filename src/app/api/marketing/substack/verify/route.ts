import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { z } from "zod";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import {
  ChannelAdapterError,
  DEFITUTORIALS_EDITOR_URL,
  verifySubstackPublication,
} from "@/lib/marketing/channels";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import {
  MarketingWorkflowResultSchema,
  type MarketingWorkflowResult,
} from "@/workflows/marketing-agent/contracts";

export const dynamic = "force-dynamic";

const MAX_VERIFICATION_REQUEST_BYTES = 4 * 1_024;
const VerificationRequestSchema = z
  .object({
    runId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\s/\\]+$/u),
    candidateId: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[^\s/\\]+$/u),
    canonicalUrl: z.string().trim().min(1).max(2_048),
  })
  .strict();

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

export async function POST(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, MAX_VERIFICATION_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof BoundedJsonBodyError ? error.status : 400;
    return NextResponse.json(
      {
        error:
          status === 413
            ? "Substack verification request too large."
            : "A JSON Substack verification request is required.",
      },
      { status, headers: PRIVATE_HEADERS },
    );
  }

  const parsed = VerificationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The Substack verification request is invalid." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  try {
    const run = getRun<MarketingWorkflowResult>(parsed.data.runId);
    if (!(await run.exists)) {
      return NextResponse.json(
        { error: "Workflow run not found." },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    }
    if ((await run.status) !== "completed") {
      return NextResponse.json(
        { error: "The workflow run has not completed an approved Substack handoff." },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }

    const result = MarketingWorkflowResultSchema.safeParse(await run.returnValue);
    if (
      !result.success
      || result.data.runId !== parsed.data.runId
      || result.data.draft.runId !== parsed.data.runId
      || result.data.approval?.decision !== "approve"
    ) {
      return NextResponse.json(
        { error: "The workflow run has no approved Substack handoff." },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }

    const candidates = result.data.draft.candidates.filter(
      (item) =>
        item.id === parsed.data.candidateId
        && item.channel === "substack"
        && item.action === "prepare_tutorial",
    );
    const presentations = result.data.draft.presentations.filter(
      (item) =>
        item.candidateId === parsed.data.candidateId
        && item.channel === "substack",
    );
    const deliveries = result.data.deliveries.filter(
      (item) =>
        item.candidateId === parsed.data.candidateId
        && item.channel === "substack"
        && item.status === "requires_human_publish"
        && item.editorUrl === DEFITUTORIALS_EDITOR_URL,
    );
    if (
      candidates.length !== 1
      || presentations.length !== 1
      || !presentations[0].title
      || deliveries.length !== 1
    ) {
      return NextResponse.json(
        { error: "The selected candidate has no approved Substack handoff." },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }

    const verification = await verifySubstackPublication({
      canonicalUrl: parsed.data.canonicalUrl,
      approvedTitle: presentations[0].title,
    });
    return NextResponse.json({
      ...verification,
      runId: parsed.data.runId,
      candidateId: parsed.data.candidateId,
    }, {
      status: 200,
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    if (error instanceof ChannelAdapterError && error.code === "invalid-input") {
      return NextResponse.json(
        {
          error:
            "Use the exact public https://defitutorials.substack.com/p/... URL for this approved handoff.",
        },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }

    const retryAfterMs = error instanceof ChannelAdapterError
      ? error.details.retryAfterMs
      : undefined;
    const retryAfter = retryAfterMs === undefined
      ? undefined
      : String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
    return NextResponse.json(
      { error: "The public DeFi Tutorials RSS could not be verified." },
      {
        status: 503,
        headers: {
          ...PRIVATE_HEADERS,
          ...(retryAfter ? { "retry-after": retryAfter } : {}),
        },
      },
    );
  }
}
