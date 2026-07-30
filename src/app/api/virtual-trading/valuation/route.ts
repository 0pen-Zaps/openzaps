import { NextRequest, NextResponse } from "next/server";

import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import { serverRateLimit } from "@/lib/relay-rate-limit";
import { fetchVirtualPortfolioValuation } from "@/lib/virtual-trading-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;
const MAX_UINT128 = (1n << 128n) - 1n;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BODY_KEYS = ["portfolioRevision", "wethRaw", "zapsRaw"] as const;
const NONNEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

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

function parsePositionRaw(
  value: unknown,
  label: "0xZAPS" | "aeWETH",
): bigint | NextResponse {
  if (typeof value !== "string" || !NONNEGATIVE_INTEGER.test(value)) {
    return noStoreJson(
      { error: `${label} position must be a canonical non-negative integer string.` },
      400,
    );
  }
  const amount = BigInt(value);
  if (amount > MAX_UINT128) {
    return noStoreJson({ error: `${label} position exceeds uint128.` }, 400);
  }
  return amount;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const quota = serverRateLimit(
    request,
    "virtual-trading-valuation",
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many portfolio valuation requests. Try again shortly." },
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
      return noStoreJson({ error: "Portfolio valuation request is too large." }, 413);
    }
    return noStoreJson({ error: "Portfolio valuation request must be valid JSON." }, 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return noStoreJson({ error: "Portfolio valuation request must be an object." }, 400);
  }

  const body = raw as Record<string, unknown>;
  if (!hasExactBodyKeys(body)) {
    return noStoreJson(
      { error: "Portfolio valuation request has missing or unsupported fields." },
      400,
    );
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

  const zapsRaw = parsePositionRaw(body.zapsRaw, "0xZAPS");
  if (zapsRaw instanceof NextResponse) return zapsRaw;
  const wethRaw = parsePositionRaw(body.wethRaw, "aeWETH");
  if (wethRaw instanceof NextResponse) return wethRaw;

  try {
    const valuation = await fetchVirtualPortfolioValuation({
      zapsRaw,
      wethRaw,
      portfolioRevision: Number(body.portfolioRevision),
    });
    return noStoreJson(valuation);
  } catch {
    return noStoreJson(
      { error: "An exact canonical portfolio valuation is temporarily unavailable." },
      503,
    );
  }
}
