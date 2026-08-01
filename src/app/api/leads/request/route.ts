import { start } from "workflow/api";
import { track } from "@vercel/analytics/server";
import { after } from "next/server";

import { leadNotificationDeliveryConfigured } from "@/lib/leads/notification-server";
import { qualificationScore } from "@/lib/leads/qualification";
import { LeadRequestSchema } from "@/lib/leads/schema";
import { isSameOriginLeadRequest } from "@/lib/leads/origin";
import {
  LeadStoreError,
  probeLeadStoreReadiness,
  submitLeadRequest,
} from "@/lib/leads/server";
import {
  BoundedJsonBodyError,
  readBoundedJsonBody,
} from "@/lib/request-body";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import { openZapsLeadNotificationWorkflow } from "@/workflows/lead-notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LEAD_REQUEST_BYTES = 16 * 1_024;
const READINESS_RATE_LIMIT_MAX = 30;
const READINESS_RATE_LIMIT_WINDOW_MS = 60_000;
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
} as const;
const LEAD_ANALYTICS_SOURCES = new Set([
  "discord",
  "farcaster",
  "github",
  "homepage",
  "newsletter",
  "rss",
  "substack",
  "x",
]);
const LEAD_ANALYTICS_REFERRER = "https://www.0xzaps.com/request-a-zap";

function leadAnalyticsSource(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return LEAD_ANALYTICS_SOURCES.has(normalized) ? normalized : "other";
}

function leadAnalyticsHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers({ referer: LEAD_ANALYTICS_REFERRER });
  const userAgent = requestHeaders.get("user-agent");
  const forwardedFor =
    requestHeaders.get("x-forwarded-for")
    ?? requestHeaders.get("x-vercel-forwarded-for");
  if (userAgent) headers.set("user-agent", userAgent);
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  return headers;
}

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

export async function GET(request: Request): Promise<Response> {
  const quota = serverRateLimit(
    request,
    "lead-intake-readiness",
    READINESS_RATE_LIMIT_MAX,
    READINESS_RATE_LIMIT_WINDOW_MS,
  );
  if (quota.limited) {
    return Response.json(
      { ready: false },
      {
        status: 429,
        headers: {
          ...PRIVATE_HEADERS,
          "retry-after": String(quota.retryAfterSeconds),
        },
      },
    );
  }
  const ready = await probeLeadStoreReadiness();
  return Response.json(
    { ready },
    {
      status: ready ? 200 : 503,
      headers: PRIVATE_HEADERS,
    },
  );
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
    try {
      if (leadNotificationDeliveryConfigured()) {
        await start(openZapsLeadNotificationWorkflow);
      }
    } catch {
      // The accepted lead and its notification outbox row are already durable.
      // The daily retention cron retries advisory workflow enqueueing.
    }
    try {
      after(async () => {
        try {
          await track(
            "lead_request_accepted",
            {
              source: leadAnalyticsSource(parsed.data.attribution.utmSource),
              score_band: qualificationScore(parsed.data) >= 3 ? "3_5" : "0_2",
            },
            { headers: leadAnalyticsHeaders(request.headers) },
          );
        } catch {
          // Conversion telemetry is advisory; durable intake must remain 202.
        }
      });
    } catch {
      // Background registration is advisory too. The lead is already durable.
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
