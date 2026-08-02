import { describe, expect, it } from "vitest";

import {
  attributedReviewedCampaignUrl,
  normalizeAttributionCampaign,
  normalizeAttributionContent,
  normalizeAttributionMedium,
  normalizeAttributionSource,
} from "@/lib/marketing/campaign-attribution";
import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
} from "@/lib/marketing/types";

describe("controlled public campaign attribution", () => {
  it("accepts exact source-controlled campaign identities and rejects lookalikes", () => {
    for (const campaignId of [
      AGENT_KIT_MARKETING_CAMPAIGN_ID,
      LEARN_HUB_MARKETING_CAMPAIGN_ID,
      SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
      "openzaps-openzaps-virtual-trading-2026-07-30",
      "defitutorials-give-an-agent-the-trigger-never-the",
    ]) {
      expect(normalizeAttributionCampaign(campaignId)).toBe(campaignId);
    }

    expect(normalizeAttributionCampaign("openzaps-private-note")).toBeNull();
    expect(normalizeAttributionCampaign("defitutorials-unpublished-draft")).toBeNull();
    expect(normalizeAttributionCampaign("person@example.com")).toBeNull();
  });

  it("normalizes only enumerated channel, medium, and content labels", () => {
    expect(normalizeAttributionSource(" X ")).toBe("x");
    expect(normalizeAttributionMedium("COMMUNITY")).toBe("community");
    expect(normalizeAttributionContent("feed_update")).toBe("feed_update");
    expect(normalizeAttributionSource("personal-handle")).toBeNull();
    expect(normalizeAttributionMedium("private-medium")).toBeNull();
    expect(normalizeAttributionContent("private-note")).toBeNull();
  });

  it.each([
    [
      "x",
      AGENT_KIT_MARKETING_CAMPAIGN_ID,
      "https://www.0xzaps.com/agent-kit",
      "social",
    ],
    [
      "discord",
      LEARN_HUB_MARKETING_CAMPAIGN_ID,
      "https://www.0xzaps.com/learn",
      "community",
    ],
    [
      "x",
      SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
      "https://www.0xzaps.com/zap?view=design",
      "social",
    ],
  ] as const)(
    "builds one deterministic %s URL without changing its destination",
    (channel, campaignId, canonicalUrl, medium) => {
      const result = attributedReviewedCampaignUrl(
        canonicalUrl,
        campaignId,
        channel,
      );
      const url = new URL(result);

      expect(`${url.origin}${url.pathname}`).toBe(
        `${new URL(canonicalUrl).origin}${new URL(canonicalUrl).pathname}`,
      );
      expect(url.searchParams.get("view")).toBe(
        new URL(canonicalUrl).searchParams.get("view"),
      );
      expect(url.searchParams.get("utm_source")).toBe(channel);
      expect(url.searchParams.get("utm_medium")).toBe(medium);
      expect(url.searchParams.get("utm_campaign")).toBe(campaignId);
      expect(url.searchParams.get("utm_content")).toBe("feed_update");
    },
  );

  it("rejects an unowned campaign, destination, credential, or fragment", () => {
    expect(() =>
      attributedReviewedCampaignUrl(
        "https://www.0xzaps.com/docs",
        "openzaps-private-note",
        "x",
      ),
    ).toThrow("campaign");
    expect(() =>
      attributedReviewedCampaignUrl(
        "https://example.com/docs",
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
        "x",
      ),
    ).toThrow("destination");
    expect(() =>
      attributedReviewedCampaignUrl(
        "https://token@www.0xzaps.com/docs",
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
        "x",
      ),
    ).toThrow("destination");
    expect(() =>
      attributedReviewedCampaignUrl(
        "https://www.0xzaps.com/docs#agents",
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
        "x",
      ),
    ).toThrow("fragment");
  });
});
