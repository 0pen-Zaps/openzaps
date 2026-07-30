import {
  isLeadAdminAuthorized,
  leadAdminUnauthorizedResponse,
} from "@/lib/leads/auth";
import {
  LeadStoreError,
  listLeadRequests,
} from "@/lib/leads/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUERY_KEYS = new Set(["limit", "minScore"]);

function integerQuery(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return fallback;
  if (!/^\d{1,3}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

export async function GET(request: Request): Promise<Response> {
  if (!isLeadAdminAuthorized(request)) {
    return leadAdminUnauthorizedResponse();
  }

  const search = new URL(request.url).searchParams;
  const keys = [...search.keys()];
  if (
    keys.some((key) => !QUERY_KEYS.has(key))
    || [...QUERY_KEYS].some((key) => search.getAll(key).length > 1)
  ) {
    return Response.json(
      { error: "Invalid lead queue query." },
      {
        status: 400,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }

  const limit = integerQuery(search.get("limit"), 50, 1, 100);
  const minScore = integerQuery(search.get("minScore"), 0, 0, 5);
  if (limit === null || minScore === null) {
    return Response.json(
      { error: "Invalid lead queue query." },
      {
        status: 400,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }

  try {
    const leads = await listLeadRequests({ limit, minScore });
    return Response.json(
      { leads, count: leads.length },
      {
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof LeadStoreError
            ? "Lead queue is temporarily unavailable."
            : "Lead queue could not be read.",
      },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
