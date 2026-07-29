import type { NextRequest } from "next/server";

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

export interface ServerRateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Best-effort warm-instance limiter for public coordination routes. It is deliberately not treated
 * as an authorization boundary; every receipt write is independently verified onchain.
 */
export function serverRateLimit(
  request: NextRequest,
  namespace: string,
  max: number,
  windowMs: number,
): ServerRateLimitResult {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for")
    ?? request.headers.get("x-forwarded-for")
    ?? "unknown";
  const ip = forwarded.split(",")[0].trim().slice(0, 128);
  const key = `${namespace}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > MAX_BUCKETS) {
      for (const [candidate, value] of buckets) if (now > value.resetAt) buckets.delete(candidate);
      while (buckets.size > MAX_BUCKETS) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    return { limited: false, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  const limited = bucket.count > max;
  return {
    limited,
    retryAfterSeconds: limited ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)) : 0,
  };
}

/** Compatibility boolean for existing callers that do not surface Retry-After yet. */
export function serverRateLimited(
  request: NextRequest,
  namespace: string,
  max: number,
  windowMs: number,
): boolean {
  return serverRateLimit(request, namespace, max, windowMs).limited;
}
