import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";

import { BridgeQuoteError, findBridgeRoute, serializeBridgeQuote } from "@/lib/bridge";
import { acrossBridgeApiEnabled, fetchAcrossBridgeQuote } from "@/lib/bridge-server";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;
const MAX_UINT256 = (1n << 256n) - 1n;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store, max-age=0" },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!acrossBridgeApiEnabled()) {
    return noStoreJson(
      {
        error: "Bridge quoting is disabled until authenticated provider credentials and durable request quota are active.",
        code: "FEATURE_DISABLED",
      },
      503,
    );
  }
  const quota = serverRateLimit(request, "bridge-quote", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many bridge quote requests. Try again in a minute." },
      {
        status: 429,
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "retry-after": String(quota.retryAfterSeconds),
        },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedJsonBodyError && error.status === 413) {
      return noStoreJson({ error: "Bridge quote request is too large." }, 413);
    }
    return noStoreJson({ error: "Bridge quote request must be JSON." }, 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return noStoreJson({ error: "Bridge quote request must be an object." }, 400);
  }

  const body = raw as Record<string, unknown>;
  const routeId = typeof body.routeId === "string" ? body.routeId : "";
  if (!findBridgeRoute(routeId)) {
    return noStoreJson({ error: "Unknown bridge route." }, 400);
  }
  if (typeof body.outputAmount !== "string" || !/^[1-9]\d*$/.test(body.outputAmount)) {
    return noStoreJson({ error: "Output amount must be a positive integer string." }, 400);
  }
  const outputAmount = BigInt(body.outputAmount);
  if (outputAmount > MAX_UINT256) {
    return noStoreJson({ error: "Output amount exceeds uint256." }, 400);
  }
  if (typeof body.depositor !== "string" || !isAddress(body.depositor)) {
    return noStoreJson({ error: "Depositor must be an EVM address." }, 400);
  }
  if (typeof body.recipient !== "string" || !isAddress(body.recipient)) {
    return noStoreJson({ error: "Recipient must be an EVM address." }, 400);
  }

  try {
    const quote = await fetchAcrossBridgeQuote({
      routeId,
      outputAmount,
      depositor: getAddress(body.depositor),
      recipient: getAddress(body.recipient),
    });
    return noStoreJson({ quote: serializeBridgeQuote(quote) });
  } catch (error) {
    const message =
      error instanceof BridgeQuoteError ? error.message : "The bridge quote could not be validated. Try again.";
    return noStoreJson({ error: message }, 502);
  }
}
