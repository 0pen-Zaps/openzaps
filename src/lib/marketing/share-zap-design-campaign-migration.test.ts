import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reviewedMarketingCampaign } from "@/lib/marketing/scheduled-template";
import { LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID } from "@/lib/marketing/types";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260802020559_queue_share_zap_design_campaign.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("shareable Zap design campaign migration", () => {
  const campaigns = (["discord", "x"] as const).map((channel) =>
    reviewedMarketingCampaign(
      LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
      channel,
    ),
  );

  it("queues both exact reviewed artifacts once and never upserts", () => {
    expect(migration).toContain(
      "insert into public.marketing_reviewed_campaigns",
    );
    expect(migration).not.toMatch(/on\s+conflict/iu);
    expect(migration.match(/'share-zap-design-v1'/gu)).toHaveLength(2);
    expect(migration).toContain("'discord'");
    expect(migration).toContain("'x'");
    expect(migration).toContain("'2026-08-07T14:00:00.000Z'::timestamptz");
    expect(migration).toContain("'2026-08-10T14:00:00.000Z'::timestamptz");

    for (const campaign of campaigns) {
      expect(migration).toContain(campaign.body);
      expect(migration).toContain(`'${campaign.contentHash}'`);
    }
  });

  it("pins every claim, fact, and source to the live authority boundary", () => {
    for (const campaign of campaigns) {
      for (const fact of campaign.requiredFacts) {
        expect(migration).toContain(`"key": "${fact.key}"`);
        expect(migration).toContain(`"sourceUrl": "${fact.sourceUrl}"`);
      }
      for (const claim of campaign.claims) {
        expect(migration).toContain(`"text": "${claim.text}"`);
        for (const factKey of claim.factKeys) {
          expect(migration).toContain(`"${factKey}"`);
        }
      }
      for (const sourceUrl of campaign.canonicalSourceUrls) {
        expect(migration).toContain(`"${sourceUrl}"`);
      }
    }
  });
});
