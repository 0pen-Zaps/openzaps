/**
 * Best-effort in-memory rate limiting for unauthenticated routes.
 *
 * On serverless this is per warm instance, not global — a first line of defence against burst
 * abuse, never a hard guarantee. A global limiter (Upstash/KV) is the production hardening.
 *
 * Extracted because the model routes need it as badly as the relay does and for a different
 * reason: `/api/agent/ask` is reachable from every public, crawlable `/explore/[address]` page,
 * so an unmetered loop over the capsule list is billable model spend, not just load.
 */

export interface RateLimit {
  /** True when this request should be refused. */
  (identifier: string): boolean;
}

/** A limiter allowing `max` requests per `windowMs`, keyed by caller identity. */
export function createRateLimit(max: number, windowMs: number): RateLimit {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (identifier: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(identifier);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(identifier, { count: 1, resetAt: now + windowMs });
      // Opportunistic sweep so a long-lived instance cannot grow unbounded.
      if (buckets.size > 5_000) {
        for (const [key, value] of buckets) if (now > value.resetAt) buckets.delete(key);
      }
      return false;
    }

    bucket.count += 1;
    return bucket.count > max;
  };
}

/**
 * The caller's identity, as far as an edge-proxied request can tell.
 *
 * `x-forwarded-for` is trivially spoofable, which is exactly why this is best-effort: it raises the
 * cost of casual abuse and does nothing against a determined one.
 */
export function callerKey(request: { headers: { get(name: string): string | null } }): string {
  return (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
}
