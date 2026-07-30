import {
  isLeadAdminAuthorized,
  leadAdminUnauthorizedResponse,
} from "@/lib/leads/auth";
import {
  deleteLeadRequest,
  LeadStoreError,
  type LeadStatus,
  updateLeadRequestLifecycle,
} from "@/lib/leads/server";
import {
  BoundedJsonBodyError,
  readBoundedJsonBody,
} from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIFECYCLE_BODY_BYTES = 512;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };
const LEAD_STATUSES = new Set<LeadStatus>([
  "new",
  "contacted",
  "qualified",
  "closed",
]);

type RouteContext = Readonly<{
  params: Promise<{ id: string }>;
}>;

function isJsonRequest(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

function lifecycleStatus(value: unknown): LeadStatus | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, "status")
  ) {
    return null;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" && LEAD_STATUSES.has(status as LeadStatus)
    ? status as LeadStatus
    : null;
}

export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  if (!isLeadAdminAuthorized(request)) {
    return leadAdminUnauthorizedResponse();
  }
  if (!isJsonRequest(request)) {
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 415, headers: PRIVATE_HEADERS },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request, MAX_LIFECYCLE_BODY_BYTES);
  } catch (error) {
    const status =
      error instanceof BoundedJsonBodyError ? error.status : 400;
    return Response.json(
      {
        error:
          status === 413
            ? "Lead lifecycle request is too large."
            : "Lead lifecycle request must be valid JSON.",
      },
      { status, headers: PRIVATE_HEADERS },
    );
  }

  const status = lifecycleStatus(raw);
  if (status === null) {
    return Response.json(
      { error: "Invalid lead lifecycle request." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  const { id } = await params;
  try {
    const result = await updateLeadRequestLifecycle(id, status);
    if (result.result === "not_found" || result.result === "expired") {
      return Response.json(
        { error: "Lead not found." },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    }
    if (result.result === "invalid_transition") {
      return Response.json(
        { error: "Invalid lead lifecycle transition." },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }
    return Response.json(
      {
        lead: {
          id: result.id,
          status: result.status,
          updatedAt: result.updatedAt,
          expiresAt: result.expiresAt,
        },
      },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof LeadStoreError && error.code === "invalid-input") {
      return Response.json(
        { error: "Invalid lead lifecycle request." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    return Response.json(
      { error: "Lead lifecycle is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  if (!isLeadAdminAuthorized(request)) {
    return leadAdminUnauthorizedResponse();
  }

  const { id } = await params;
  try {
    const deleted = await deleteLeadRequest(id);
    if (!deleted) {
      return Response.json(
        { error: "Lead not found." },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    }
    return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof LeadStoreError && error.code === "invalid-input") {
      return Response.json(
        { error: "Invalid lead deletion request." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    return Response.json(
      { error: "Lead deletion is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
