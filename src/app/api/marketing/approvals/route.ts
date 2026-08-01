import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import {
  marketingApprovalHook,
  marketingApprovalToken,
} from "@/workflows/marketing-agent";

export const dynamic = "force-dynamic";
const MAX_APPROVAL_REQUEST_BYTES = 4 * 1_024;

const ApprovalRequestSchema = z
  .object({
    runId: z.string().min(1).max(200).refine((value) => !/[\s/\\]/u.test(value)),
    decision: z.enum(["approve", "reject"]),
    comment: z.string().trim().max(1_000).optional(),
    tutorialApproval: z
      .object({
        tutorialId: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
        sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        bodySha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.decision === "reject" && approval.tutorialApproval) {
      context.addIssue({
        code: "custom",
        message: "A rejection cannot include a tutorial approval.",
        path: ["tutorialApproval"],
      });
    }
  });

export async function POST(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, MAX_APPROVAL_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof BoundedJsonBodyError ? error.status : 400;
    return NextResponse.json(
      { error: status === 413 ? "Approval request too large." : "A JSON approval request is required." },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
  const parsed = ApprovalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The approval request is invalid.", issues: parsed.error.issues },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const approvedBy =
      process.env.OPENZAPS_MARKETING_APPROVER_ID?.trim()
      || "authenticated-operator";
    const resumed = await marketingApprovalHook.resume(
      marketingApprovalToken(parsed.data.runId),
      {
        decision: parsed.data.decision,
        approvedBy,
        ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
        ...(parsed.data.decision === "approve" && parsed.data.tutorialApproval
          ? {
              tutorialApproval: {
                decision: "approve" as const,
                approvedBy,
                ...parsed.data.tutorialApproval,
              },
            }
          : {}),
      },
    );
    if (!resumed) {
      return NextResponse.json(
        { error: "This draft is not awaiting approval or was already decided." },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      { runId: resumed.runId, status: parsed.data.decision === "approve" ? "approved" : "rejected" },
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "This draft is not awaiting approval or the decision was invalid." },
      { status: 409, headers: { "cache-control": "private, no-store" } },
    );
  }
}
