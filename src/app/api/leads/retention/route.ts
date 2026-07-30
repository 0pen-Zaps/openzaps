import { start } from "workflow/api";

import { isCronAuthorized } from "@/lib/cron-auth";
import { leadNotificationDeliveryConfigured } from "@/lib/leads/notification-server";
import {
  LeadStoreError,
  purgeExpiredLeadRequests,
} from "@/lib/leads/server";
import { openZapsLeadNotificationWorkflow } from "@/workflows/lead-notification";

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

  let deliveryQueued = false;
  try {
    if (leadNotificationDeliveryConfigured()) {
      await start(openZapsLeadNotificationWorkflow);
      deliveryQueued = true;
    }
  } catch {
    // Recovery enqueueing is advisory and must never block retention.
  }

  try {
    const deletedCount = await purgeExpiredLeadRequests();
    return Response.json(
      { purged: true, deletedCount, deliveryQueued },
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
