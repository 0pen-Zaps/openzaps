import {
  isLeadAdminAuthorized,
  leadAdminUnauthorizedResponse,
} from "@/lib/leads/auth";
import {
  buildLeadScorecard,
  LEAD_SCORECARD_MAX_ROWS,
} from "@/lib/leads/scorecard";
import {
  LeadStoreError,
  listLeadRequests,
} from "@/lib/leads/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  if (!isLeadAdminAuthorized(request)) {
    return leadAdminUnauthorizedResponse();
  }

  if (new URL(request.url).search.length > 0) {
    return Response.json(
      { error: "Invalid lead scorecard query." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  try {
    const leads = await listLeadRequests({
      limit: LEAD_SCORECARD_MAX_ROWS,
      minScore: 0,
    });
    return Response.json(
      { scorecard: buildLeadScorecard(leads) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof LeadStoreError
            ? "Lead scorecard is temporarily unavailable."
            : "Lead scorecard could not be read.",
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
