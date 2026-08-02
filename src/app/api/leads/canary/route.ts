import {
  isLeadAdminAuthorized,
  leadAdminUnauthorizedResponse,
} from "@/lib/leads/auth";
import {
  LeadStoreError,
  runLeadIntakeRollbackCanary,
} from "@/lib/leads/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

/**
 * Run the fixed, database-rolled-back lead-intake canary.
 *
 * The route accepts no query or body. In particular, caller-provided contact
 * data can never reach the service-role RPC. It also never starts the lead
 * notification workflow or emits conversion analytics.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isLeadAdminAuthorized(request)) {
    return leadAdminUnauthorizedResponse();
  }

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return Response.json(
      { error: "The lead-intake canary accepts no input." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  try {
    const canary = await runLeadIntakeRollbackCanary();
    return Response.json(
      { canary },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof LeadStoreError
            ? "Lead intake rollback could not be confirmed."
            : "Lead intake rollback canary could not run.",
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
