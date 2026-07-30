import { isCronAuthorized } from "@/lib/cron-auth";
import {
  LeadStoreError,
  purgeExpiredLeadRequests,
} from "@/lib/leads/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized." },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  try {
    const deletedCount = await purgeExpiredLeadRequests();
    return Response.json(
      { purged: true, deletedCount },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof LeadStoreError
            ? "Lead retention is temporarily unavailable."
            : "Lead retention could not be completed.",
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
