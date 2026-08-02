import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  availableReviewOnlyMarketingCampaigns,
  isReviewedMarketingCampaignCandidate,
  reviewedMarketingCampaign,
  reviewedMarketingCampaignCanonicalPayload,
  reviewedMarketingCampaignIsReviewOnly,
  reviewedMarketingCampaigns,
  reviewOnlyMarketingCampaigns,
} from "@/lib/marketing/scheduled-template";
import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  FEE_REWARDS_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  type MarketingCandidate,
} from "@/lib/marketing/types";

describe("source-reviewed marketing campaigns", () => {
  it("pins unique immutable identities, queue order, typed evidence, and content hashes", () => {
    const campaigns = reviewedMarketingCampaigns();
    const identities = campaigns.map(
      (campaign) => `${campaign.id}:${campaign.channel}`,
    );
    const queueOrders = campaigns.map((campaign) => campaign.queueOrder);

    expect(new Set(identities).size).toBe(campaigns.length);
    expect(new Set(queueOrders).size).toBe(campaigns.length);
    expect([...queueOrders].sort((left, right) => left - right)).toEqual(
      queueOrders,
    );

    for (const campaign of campaigns) {
      const claimedFacts = new Set(
        campaign.claims
          .filter((claim) => claim.treatment !== "omitted")
          .flatMap((claim) => claim.factKeys),
      );
      const requiredFactKeys = campaign.requiredFacts.map((fact) => fact.key);
      const requiredSourceUrls = campaign.requiredFacts.map(
        (fact) => fact.sourceUrl,
      );

      expect(campaign.requiredFacts.length).toBeGreaterThan(0);
      expect(new Set(requiredFactKeys).size).toBe(requiredFactKeys.length);
      expect(new Set(requiredSourceUrls).size).toBe(requiredSourceUrls.length);
      expect([...requiredFactKeys].sort()).toEqual([...claimedFacts].sort());
      expect(campaign.canonicalSourceUrls).toEqual(requiredSourceUrls);
      expect(new Set(campaign.canonicalSourceUrls).size).toBe(
        campaign.canonicalSourceUrls.length,
      );
      expect(campaign.contentHash).toBe(
        createHash("sha256")
          .update(
            JSON.stringify(reviewedMarketingCampaignCanonicalPayload(campaign)),
          )
          .digest("hex"),
      );
    }
  });

  it("canonicalizes a non-null not-before timestamp before hashing", () => {
    const campaign = reviewedMarketingCampaigns()[0]!;

    expect(
      reviewedMarketingCampaignCanonicalPayload({
        ...campaign,
        notBefore: "2026-08-03T06:00:00-04:00",
      }).notBefore,
    ).toBe("2026-08-03T10:00:00.000Z");
  });

  it.each(["discord", "x"] as const)(
    "auto-authorizes the Agent Kit %s campaign only with exact fresh evidence",
    (channel) => {
    const campaign = reviewedMarketingCampaign(
      AGENT_KIT_MARKETING_CAMPAIGN_ID,
      channel,
    );
    const observedAt = channel === "discord"
      ? "2026-08-03T14:00:00.000Z"
      : "2026-08-05T14:00:00.000Z";
    const candidate: MarketingCandidate = {
      id: `agent-kit-campaign-${channel}`,
      channel,
      action: "broadcast",
      kind: "product_update",
      topics: [...campaign.topics],
      body: campaign.body,
      links: [...campaign.links],
      disclosures: [...campaign.disclosures],
      claims: campaign.claims.map((claim) => ({
        ...claim,
        factKeys: [...claim.factKeys],
      })),
      flags: { ...campaign.flags },
      interaction: null,
      sourcePacket: {
        id: "agent-kit-campaign-sources",
        createdAt: observedAt,
        protocolPreAudit: true,
        externalData: [],
        interaction: null,
        facts: campaign.requiredFacts.map((fact) => ({
          key: fact.key,
          label: fact.key,
          value: "confirmed",
          status: "confirmed" as const,
          sourceUrl: fact.sourceUrl,
          observedAt,
        })),
      },
    };

    expect(
      isReviewedMarketingCampaignCandidate(
        candidate,
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
      ),
    ).toBe(true);
    if (channel === "x") {
      expect(Array.from(campaign.body)).toHaveLength(269);
    }
    expect(
      isReviewedMarketingCampaignCandidate(
        { ...candidate, body: `${candidate.body}\nChanged.` },
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
      ),
    ).toBe(false);
    expect(
      isReviewedMarketingCampaignCandidate(
        {
          ...candidate,
          sourcePacket: {
            ...candidate.sourcePacket,
            facts: candidate.sourcePacket.facts.map((fact, index) =>
              index === 0 ? { ...fact, status: "unavailable", value: null } : fact,
            ),
          },
        },
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
      ),
    ).toBe(false);
    expect(
      isReviewedMarketingCampaignCandidate(
        {
          ...candidate,
          sourcePacket: {
            ...candidate.sourcePacket,
            facts: candidate.sourcePacket.facts.map((fact, index) =>
              index === 0
                ? { ...fact, sourceUrl: "https://www.0xzaps.com/docs" }
                : fact,
            ),
          },
        },
        AGENT_KIT_MARKETING_CAMPAIGN_ID,
      ),
    ).toBe(false);
  });

  it.each(["x", "discord"] as const)(
    "auto-authorizes the Learn hub %s campaign only with its exact live receipt",
    (channel) => {
      const campaign = reviewedMarketingCampaign(
        LEARN_HUB_MARKETING_CAMPAIGN_ID,
        channel,
      );
      const observedAt = "2026-08-04T14:00:00.000Z";
      const candidate: MarketingCandidate = {
        id: `learn-hub-campaign-${channel}`,
        channel,
        action: "broadcast",
        kind: "product_update",
        topics: [...campaign.topics],
        body: campaign.body,
        links: [...campaign.links],
        disclosures: [...campaign.disclosures],
        claims: campaign.claims.map((claim) => ({
          ...claim,
          factKeys: [...claim.factKeys],
        })),
        flags: { ...campaign.flags },
        interaction: null,
        sourcePacket: {
          id: `learn-hub-campaign-${channel}-sources`,
          createdAt: observedAt,
          protocolPreAudit: true,
          externalData: [],
          interaction: null,
          facts: campaign.requiredFacts.map((fact) => ({
            key: fact.key,
            label: fact.key,
            value: "confirmed",
            status: "confirmed" as const,
            sourceUrl: fact.sourceUrl,
            observedAt,
          })),
        },
      };

      expect(
        isReviewedMarketingCampaignCandidate(
          candidate,
          LEARN_HUB_MARKETING_CAMPAIGN_ID,
        ),
      ).toBe(true);
      expect(
        isReviewedMarketingCampaignCandidate(
          {
            ...candidate,
            sourcePacket: {
              ...candidate.sourcePacket,
              facts: candidate.sourcePacket.facts.map((fact) => ({
                ...fact,
                status: "unavailable" as const,
                value: null,
              })),
            },
          },
          LEARN_HUB_MARKETING_CAMPAIGN_ID,
        ),
      ).toBe(false);
      if (channel === "x") {
        expect(Array.from(campaign.body)).toHaveLength(265);
      }
    },
  );

  it.each(["discord", "x"] as const)(
    "auto-authorizes the shareable-design %s campaign only with the exact authority-boundary receipt",
    (channel) => {
      const campaign = reviewedMarketingCampaign(
        SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
        channel,
      );
      const observedAt = channel === "discord"
        ? "2026-08-07T14:00:00.000Z"
        : "2026-08-10T14:00:00.000Z";
      const candidate: MarketingCandidate = {
        id: `share-zap-design-${channel}`,
        channel,
        action: "broadcast",
        kind: "product_update",
        topics: [...campaign.topics],
        body: campaign.body,
        links: [...campaign.links],
        disclosures: [...campaign.disclosures],
        claims: campaign.claims.map((claim) => ({
          ...claim,
          factKeys: [...claim.factKeys],
        })),
        flags: { ...campaign.flags },
        interaction: null,
        sourcePacket: {
          id: `share-zap-design-${channel}-sources`,
          createdAt: observedAt,
          protocolPreAudit: true,
          externalData: [],
          interaction: null,
          facts: campaign.requiredFacts.map((fact) => ({
            key: fact.key,
            label: fact.key,
            value: "confirmed",
            status: "confirmed" as const,
            sourceUrl: fact.sourceUrl,
            observedAt,
          })),
        },
      };

      expect(
        isReviewedMarketingCampaignCandidate(
          candidate,
          SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
        ),
      ).toBe(true);
      expect(
        isReviewedMarketingCampaignCandidate(
          {
            ...candidate,
            sourcePacket: {
              ...candidate.sourcePacket,
              facts: candidate.sourcePacket.facts.map((fact) => ({
                ...fact,
                status: "unavailable" as const,
                value: null,
              })),
            },
          },
          SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
        ),
      ).toBe(false);
      if (channel === "x") {
        expect(Array.from(campaign.body).length).toBeLessThanOrEqual(280);
      }
    },
  );

  it.each(["x", "discord"] as const)(
    "keeps the fee rewards %s artifact owner-review-only",
    (channel) => {
      const campaign = reviewedMarketingCampaign(
        FEE_REWARDS_MARKETING_CAMPAIGN_ID,
        channel,
      );
      const observedAt = "2026-08-03T00:24:00.000Z";
      const candidate: MarketingCandidate = {
        id: `fee-rewards-${channel}`,
        channel,
        action: "broadcast",
        kind: "product_update",
        topics: [...campaign.topics],
        body: campaign.body,
        links: [...campaign.links],
        disclosures: [...campaign.disclosures],
        claims: campaign.claims.map((claim) => ({
          ...claim,
          factKeys: [...claim.factKeys],
        })),
        flags: { ...campaign.flags },
        interaction: null,
        sourcePacket: {
          id: `fee-rewards-${channel}-sources`,
          createdAt: observedAt,
          protocolPreAudit: true,
          externalData: [],
          interaction: null,
          facts: campaign.requiredFacts.map((fact) => ({
            key: fact.key,
            label: fact.key,
            value: "confirmed",
            status: "confirmed" as const,
            sourceUrl: fact.sourceUrl,
            observedAt,
          })),
        },
      };

      expect(campaign.notBefore).toBe("2026-08-03T00:23:00.000Z");
      expect(campaign.notAfter).toBe("2026-08-10T00:23:00.000Z");
      expect(campaign.topics).toEqual(["token", "trading"]);
      expect(campaign.body).toContain(
        "active from Aug 3 00:23 UTC until Aug 10 00:23 UTC",
      );
      expect(campaign.body).toContain("claims until Sep 9 00:23 UTC");
      expect(
        reviewedMarketingCampaignIsReviewOnly(
          FEE_REWARDS_MARKETING_CAMPAIGN_ID,
          channel,
        ),
      ).toBe(true);
      expect(
        isReviewedMarketingCampaignCandidate(
          candidate,
          FEE_REWARDS_MARKETING_CAMPAIGN_ID,
        ),
      ).toBe(false);
      if (channel === "x") {
        expect(Array.from(campaign.body).length).toBeLessThanOrEqual(280);
      }
    },
  );

  it("exposes fee rewards only through the source review accessor and never the durable cron queue", () => {
    const reviewOnly = reviewOnlyMarketingCampaigns();
    const identities = reviewOnly.map(
      (campaign) => `${campaign.id}:${campaign.channel}`,
    );

    expect(identities).toEqual([
      `${FEE_REWARDS_MARKETING_CAMPAIGN_ID}:x`,
      `${FEE_REWARDS_MARKETING_CAMPAIGN_ID}:discord`,
    ]);
    expect(
      availableReviewOnlyMarketingCampaigns(
        "2026-08-03T00:22:59.999Z",
      ),
    ).toEqual([]);
    expect(
      availableReviewOnlyMarketingCampaigns(
        "2026-08-03T00:23:00.000Z",
      ).map((campaign) => `${campaign.id}:${campaign.channel}`),
    ).toEqual(identities);
    expect(
      availableReviewOnlyMarketingCampaigns(
        "2026-08-10T00:22:59.999Z",
      ).map((campaign) => `${campaign.id}:${campaign.channel}`),
    ).toEqual(identities);
    expect(
      availableReviewOnlyMarketingCampaigns(
        "2026-08-10T00:23:00.000Z",
      ),
    ).toEqual([]);

    const migrationsDirectory = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../supabase/migrations",
    );
    const durableMigrationText = readdirSync(migrationsDirectory)
      .filter((fileName) => fileName.endsWith(".sql"))
      .map((fileName) => readFileSync(join(migrationsDirectory, fileName), "utf8"))
      .join("\n");

    expect(durableMigrationText).not.toContain(
      FEE_REWARDS_MARKETING_CAMPAIGN_ID,
    );
  });
});
