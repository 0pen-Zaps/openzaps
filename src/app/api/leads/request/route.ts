import { LeadRequestSchema } from "@/lib/leads/schema";
import { isSameOriginLeadRequest } from "@/lib/leads/origin";
import {
  LeadStoreError,
  submitLeadRequest,
} from "@/lib/leads/server";
import {
  BoundedJsonBodyError,
  readBoundedJsonBody,
} from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LEAD_REQUEST_BYTES = 16 * 1_024;
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

function intakeResponse(
  body: { accepted: boolean; error?: string },
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...extraHeaders },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginLeadRequest(request)) {
    return intakeResponse(
      { accepted: false, error: "Request origin was not accepted." },
      403,
    );
  }

  const mediaType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    ?? "";
  if (mediaType !== "application/json") {
    return intakeResponse(
      { accepted: false, error: "A JSON request is required." },
      415,
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, MAX_LEAD_REQUEST_BYTES);
  } catch (error) {
    const status =
      error instanceof BoundedJsonBodyError ? error.status : 400;
    return intakeResponse(
      {
        accepted: false,
        error:
          status === 413
            ? "Request is too large."
            : "Invalid request.",
      },
      status,
    );
  }

  const parsed = LeadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return intakeResponse(
      { accepted: false, error: "Invalid request." },
      400,
    );
  }

  // A filled honeypot receives the same minimal success as a real submission,
  // but it never reaches the store or consumes a quota slot.
  if (parsed.data.website.length > 0) {
    return intakeResponse({ accepted: true }, 202);
  }

  try {
    const result = await submitLeadRequest(parsed.data, request.headers);
    if (result === "quota_reached") {
      return intakeResponse(
        {
          accepted: false,
          error: "Please try again later.",
        },
        429,
        { "retry-after": "86400" },
      );
    }
    return intakeResponse({ accepted: true }, 202);
  } catch (error) {
    if (error instanceof LeadStoreError && error.code === "invalid-input") {
      return intakeResponse(
        { accepted: false, error: "Invalid request." },
        400,
      );
    }
    return intakeResponse(
      {
        accepted: false,
        error: "Lead intake is temporarily unavailable.",
      },
      503,
    );
  }
}
