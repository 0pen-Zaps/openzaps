import { track } from "@vercel/analytics";

export type AnalyticsPayload = Record<string, string | number | boolean | null | undefined>;

const FIRST_TOUCH_STORAGE_KEY = "openzaps:analytics:first-touch:v1";
const CAMPAIGN_ARRIVAL_STORAGE_KEY = "openzaps:analytics:campaign-arrival:v1";
const MAX_PROVIDER_PROPERTIES = 2;

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
const EVM_IDENTIFIER_PATTERN = /\b0x[a-f0-9]{40,64}\b/i;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const SECRET_PATTERN = /\b(?:sk-(?:proj-)?|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const MAX_PROPERTY_LENGTH = 100;

const ATTRIBUTION_KEYS = new Set(["source", "medium", "campaign", "content"]);
const ATTRIBUTION_SOURCES = new Set([
  "discord",
  "farcaster",
  "github",
  "homepage",
  "newsletter",
  "openzaps",
  "rss",
  "substack",
  "x",
]);
const ATTRIBUTION_MEDIA = new Set([
  "community",
  "email",
  "product",
  "referral",
  "rss",
  "social",
  "website",
]);
const ATTRIBUTION_CONTENT = new Set([
  "app_nav",
  "developer_section",
  "docs_release",
  "execution_demo",
  "feed_update",
  "final_cta",
  "hero",
  "homepage_recent",
  "landing_footer",
  "learn_hub",
  "nav",
  "request_form",
  "request_success",
  "site_footer",
  "tutorial",
  "virtual_trading",
]);
const ATTRIBUTION_CAMPAIGNS = new Set([
  "product_update",
  "request_a_zap",
  "tutorial_update",
]);

const PROVIDER_PROPERTY_PRIORITY = [
  "status",
  "source",
  "persona",
  "route",
  "mode",
  "recipe",
  "cta",
  "content",
  "blocks",
  "block",
  "guard",
  "published",
  "replaced",
  "score_band",
  "fee",
  "campaign",
  "medium",
] as const;

function coarseCampaign(value: string): string | null {
  if (value === "request_a_zap") return value;
  if (value === "virtual-trading" || value.startsWith("openzaps-")) {
    return "product_update";
  }
  if (value.startsWith("defitutorials-")) return "tutorial_update";
  return null;
}

function coarseAttributionValue(key: string, value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_PROPERTY_LENGTH) return null;

  if (key === "source") return ATTRIBUTION_SOURCES.has(normalized) ? normalized : null;
  if (key === "medium") return ATTRIBUTION_MEDIA.has(normalized) ? normalized : null;
  if (key === "content") return ATTRIBUTION_CONTENT.has(normalized) ? normalized : null;
  if (key === "campaign") return coarseCampaign(normalized);
  return null;
}

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
      if (ATTRIBUTION_KEYS.has(key)) {
        const coarseValue = coarseAttributionValue(key, normalized);
        if (coarseValue) sanitized[key] = coarseValue;
      } else {
        sanitized[key] = normalized;
      }
      continue;
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = value;
      continue;
    }

    if (typeof value === "boolean" || value === null) sanitized[key] = value;
  }

  return sanitized;
}

function attributionFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const values = sanitizeAnalyticsPayload({
    source: params.get("utm_source") ?? undefined,
    medium: params.get("utm_medium") ?? undefined,
    campaign: params.get("utm_campaign") ?? undefined,
    content: params.get("utm_content") ?? undefined,
  });
  if (typeof values.source !== "string") return null;

  return [
    values.source,
    typeof values.medium === "string" ? values.medium : "_",
    typeof values.campaign === "string" ? values.campaign : "_",
    typeof values.content === "string" ? values.content : "_",
  ].join("|");
}

function validStoredAttribution(value: string): boolean {
  const [source, medium, campaign, content, extra] = value.split("|");
  return (
    extra === undefined
    && ATTRIBUTION_SOURCES.has(source)
    && (medium === "_" || ATTRIBUTION_MEDIA.has(medium))
    && (campaign === "_" || ATTRIBUTION_CAMPAIGNS.has(campaign))
    && (content === "_" || ATTRIBUTION_CONTENT.has(content))
  );
}

/**
 * Preserve one coarse, anonymous first-touch label for the current tab. Raw
 * query values, referrers, URLs, and identifiers are never written to storage.
 */
export function captureAnalyticsAttribution(search?: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    const existing = window.sessionStorage.getItem(FIRST_TOUCH_STORAGE_KEY);
    if (existing && validStoredAttribution(existing)) return existing;

    const candidate = attributionFromSearch(search ?? window.location.search);
    if (!candidate) return null;
    window.sessionStorage.setItem(FIRST_TOUCH_STORAGE_KEY, candidate);
    return candidate;
  } catch {
    // Hardened browsers can deny storage. The current page's coarse label is
    // still safe and useful; it simply will not survive the next navigation.
    return attributionFromSearch(search ?? window.location.search);
  }
}

/** Claim one campaign-arrival event per coarse first touch and browser tab. */
export function claimAnalyticsCampaignArrival(attribution: string): boolean {
  if (typeof window === "undefined" || !validStoredAttribution(attribution)) return false;

  try {
    if (window.sessionStorage.getItem(CAMPAIGN_ARRIVAL_STORAGE_KEY) === attribution) {
      return false;
    }
    window.sessionStorage.setItem(CAMPAIGN_ARRIVAL_STORAGE_KEY, attribution);
    return true;
  } catch {
    // The root analytics island mounts once per document, so a storage-denied
    // browser can still contribute one non-persistent campaign arrival.
    return true;
  }
}

export function providerAnalyticsPayload(
  payload: AnalyticsPayload,
  attribution: string | null,
): AnalyticsPayload {
  const providerPayload: AnalyticsPayload = {};

  if (attribution && validStoredAttribution(attribution)) {
    providerPayload.acquisition = attribution;
  }

  for (const key of PROVIDER_PROPERTY_PRIORITY) {
    if (Object.keys(providerPayload).length >= MAX_PROVIDER_PROPERTIES) break;
    if (attribution && (key === "source" || key === "medium" || key === "campaign")) {
      continue;
    }
    const value = payload[key];
    if (value !== undefined) providerPayload[key] = value;
  }

  return providerPayload;
}

export function trackEvent(event: string, payload: AnalyticsPayload = {}): void {
  if (typeof window === "undefined" || !EVENT_NAME_PATTERN.test(event)) return;

  const sanitizedPayload = sanitizeAnalyticsPayload(payload);
  const attribution = captureAnalyticsAttribution();
  const bridgePayload = attribution
    ? { ...sanitizedPayload, acquisition: attribution }
    : sanitizedPayload;
  const providerPayload = providerAnalyticsPayload(sanitizedPayload, attribution);

  const detail = {
    event,
    payload: bridgePayload,
    ts: new Date().toISOString(),
    path: window.location.pathname,
  };

  window.dispatchEvent(new CustomEvent("openzaps:analytics", { detail }));

  try {
    track(event, providerPayload);
  } catch {
    // Analytics must never interrupt a product or signing flow.
  }

  if (process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "1") {
    if (Object.keys(bridgePayload).length > MAX_PROVIDER_PROPERTIES) {
      console.info("[openzaps:analytics] provider payload reduced to two anonymous properties");
    }
    console.info("[openzaps:analytics]", detail);
  }
}
