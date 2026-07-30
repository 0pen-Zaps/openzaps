import { NextRequest, NextResponse } from "next/server";

import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import { isVirtualMarketId } from "@/lib/virtual-trading";
import { fetchVirtualFill } from "@/lib/virtual-trading-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const MAX_UINT128 = (1n << 128n) - 1n;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const CLIENT_ORDER_ID = /^[A-Za-z0-9-]{8,80}$/;
const BODY_KEYS = [
  "clientOrderId",
  "inputRaw",
  "marketId",
  "portfolioRevision",
  "side",
] as const;

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store, max-age=0" },
  });
}

function hasExactBodyKeys(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body).sort();
  return keys.length === BODY_KEYS.length
    && BODY_KEYS.every((key, index) => keys[index] === key);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(
    request,
    "virtual-trading-quote",
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many virtual quote requests. Try again shortly." },
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
      return noStoreJson({ error: "Virtual quote request is too large." }, 413);
    }
    return noStoreJson({ error: "Virtual quote request must be valid JSON." }, 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return noStoreJson({ error: "Virtual quote request must be an object." }, 400);
  }

  const body = raw as Record<string, unknown>;
  if (!hasExactBodyKeys(body)) {
    return noStoreJson(
      { error: "Virtual quote request has missing or unsupported fields." },
      400,
    );
  }
  if (!isVirtualMarketId(body.marketId)) {
    return noStoreJson({ error: "Unknown virtual market." }, 400);
  }
  if (body.side !== "buy" && body.side !== "sell") {
    return noStoreJson({ error: "Virtual order side must be buy or sell." }, 400);
  }
  if (typeof body.inputRaw !== "string" || !/^[1-9]\d*$/.test(body.inputRaw)) {
    return noStoreJson(
      { error: "Virtual quote input must be a positive canonical integer string." },
      400,
    );
  }
  const inputRaw = BigInt(body.inputRaw);
  if (inputRaw > MAX_UINT128) {
    return noStoreJson({ error: "Virtual quote input exceeds uint128." }, 400);
  }
  if (
    !Number.isSafeInteger(body.portfolioRevision)
    || Number(body.portfolioRevision) < 0
  ) {
    return noStoreJson(
      { error: "Portfolio revision must be a non-negative safe integer." },
      400,
    );
  }
  if (
    typeof body.clientOrderId !== "string"
    || !CLIENT_ORDER_ID.test(body.clientOrderId)
  ) {
    return noStoreJson(
      { error: "Client order ID must be 8-80 letters, numbers, or hyphens." },
      400,
    );
  }

  try {
    const fill = await fetchVirtualFill({
      marketId: body.marketId,
      side: body.side,
      inputRaw,
      clientOrderId: body.clientOrderId,
      portfolioRevision: Number(body.portfolioRevision),
    });
    return noStoreJson(fill);
  } catch {
    return noStoreJson(
      { error: "A canonical virtual quote is temporarily unavailable." },
      503,
    );
  }
}
