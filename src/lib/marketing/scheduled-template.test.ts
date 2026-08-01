import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  reviewedMarketingCampaignCanonicalPayload,
  reviewedMarketingCampaigns,
} from "@/lib/marketing/scheduled-template";

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
});
