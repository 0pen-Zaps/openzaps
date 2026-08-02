import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  FEE_REWARDS_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  SCHEDULED_MARKETING_TEMPLATE_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
} from "@/lib/marketing/types";

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
  "builder_review",
  "developer_section",
  "docs_release",
  "execution_demo",
  "agent_kit",
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

/**
 * Public, source-controlled campaign identities only. Keep this explicit: raw
 * UTM text must never become durable lead data or a high-cardinality metric.
 * The syndication tests ensure every reviewable feed slug is represented here.
 */
const ATTRIBUTION_CAMPAIGNS = new Set([
  "agent_kit",
  "product_update",
  "request_a_zap",
  "tutorial_update",
  "virtual-trading",
  SCHEDULED_MARKETING_TEMPLATE_ID,
  LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  FEE_REWARDS_MARKETING_CAMPAIGN_ID,
  "openzaps-fee-rewards-2026-08-02",
  "openzaps-openzaps-fee-rewards-2026-08-02",
  "openzaps-virtual-trading-2026-07-30",
  "openzaps-request-a-zap-2026-07-30",
  "openzaps-agent-kit-2026-07-29",
  "openzaps-bounded-agent-authority-2026-07-27",
  "openzaps-live-chain-explorer-2026-07-28",
  "openzaps-openzaps-virtual-trading-2026-07-30",
  "openzaps-openzaps-request-a-zap-2026-07-30",
  "openzaps-openzaps-agent-kit-2026-07-29",
  "openzaps-openzaps-bounded-agent-authority-2026-07-27",
  "openzaps-openzaps-live-chain-explorer-2026-07-28",
  "defitutorials-give-an-agent-the-trigger-never-the",
  "defitutorials-paper-trade-first-authority-map",
  "defitutorials-earn-pool-fees-not-emissions",
]);

function normalizedControlledValue(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 100 && allowed.has(normalized)
    ? normalized
    : null;
}

export function normalizeAttributionSource(value: unknown): string | null {
  return normalizedControlledValue(value, ATTRIBUTION_SOURCES);
}

export function normalizeAttributionMedium(value: unknown): string | null {
  return normalizedControlledValue(value, ATTRIBUTION_MEDIA);
}

export function normalizeAttributionContent(value: unknown): string | null {
  return normalizedControlledValue(value, ATTRIBUTION_CONTENT);
}

export function normalizeAttributionCampaign(value: unknown): string | null {
  return normalizedControlledValue(value, ATTRIBUTION_CAMPAIGNS);
}

export type AttributedCampaignChannel = "x" | "discord";

/** Build the exact public URL pinned into one reviewed campaign artifact. */
export function attributedReviewedCampaignUrl(
  canonicalUrl: string,
  campaignId: string,
  channel: AttributedCampaignChannel,
): string {
  if (normalizeAttributionCampaign(campaignId) !== campaignId) {
    throw new Error("Reviewed campaign attribution uses an unknown campaign.");
  }

  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    throw new Error("Reviewed campaign attribution destination is invalid.");
  }
  if (
    url.origin !== "https://www.0xzaps.com"
    || url.username
    || url.password
    || url.port
    || !/^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?\/?$/u.test(
      url.pathname,
    )
  ) {
    throw new Error("Reviewed campaign attribution destination is invalid.");
  }
  if (url.hash) {
    throw new Error("Reviewed campaign attribution does not accept a fragment.");
  }

  const existingQuery = [...url.searchParams];
  const hasAllowedDesignView =
    url.pathname === "/zap"
    && existingQuery.length === 1
    && existingQuery[0]?.[0] === "view"
    && existingQuery[0]?.[1] === "design";
  if (existingQuery.length > 0 && !hasAllowedDesignView) {
    throw new Error("Reviewed campaign attribution destination query is invalid.");
  }

  url.searchParams.set("utm_source", channel);
  url.searchParams.set(
    "utm_medium",
    channel === "x" ? "social" : "community",
  );
  url.searchParams.set("utm_campaign", campaignId);
  url.searchParams.set("utm_content", "feed_update");
  return url.toString();
}
