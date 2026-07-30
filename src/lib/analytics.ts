import { track } from "@vercel/analytics";

export type AnalyticsPayload = Record<string, string | number | boolean | null | undefined>;

const ALLOWED_PROPERTY_KEYS = new Set([
  "block",
  "blocks",
  "campaign",
  "content",
  "cta",
  "fee",
  "guard",
  "medium",
  "mode",
  "persona",
  "published",
  "recipe",
  "replaced",
  "route",
  "score_band",
  "source",
  "status",
]);

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const EVM_IDENTIFIER_PATTERN = /\b0x[a-fA-F0-9]{40,64}\b/;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const SECRET_PATTERN = /\b(?:sk-(?:proj-)?|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const MAX_PROPERTY_LENGTH = 100;

export function sanitizeAnalyticsPayload(payload: AnalyticsPayload): AnalyticsPayload {
  const sanitized: AnalyticsPayload = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key) || value === undefined) continue;

    if (typeof value === "string") {
      const normalized = value.trim();
      if (
        normalized.length === 0 ||
        normalized.length > MAX_PROPERTY_LENGTH ||
        EVM_IDENTIFIER_PATTERN.test(normalized) ||
        EMAIL_PATTERN.test(normalized) ||
        SECRET_PATTERN.test(normalized) ||
        URL_PATTERN.test(normalized)
      ) {
        continue;
      }
      sanitized[key] = normalized;
      continue;
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = value;
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export function trackEvent(event: string, payload: AnalyticsPayload = {}): void {
  if (typeof window === "undefined" || !EVENT_NAME_PATTERN.test(event)) return;

  const sanitizedPayload = sanitizeAnalyticsPayload(payload);

  const detail = {
    event,
    payload: sanitizedPayload,
    ts: new Date().toISOString(),
    path: window.location.pathname,
  };

  window.dispatchEvent(new CustomEvent("openzaps:analytics", { detail }));

  try {
    track(event, sanitizedPayload);
  } catch {
    // Analytics must never interrupt a product or signing flow.
  }

  if (process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "1") {
    console.info("[openzaps:analytics]", detail);
  }
}
