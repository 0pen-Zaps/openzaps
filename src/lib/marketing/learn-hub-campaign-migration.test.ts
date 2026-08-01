import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reviewedMarketingCampaign } from "@/lib/marketing/scheduled-template";
import { LEARN_HUB_MARKETING_CAMPAIGN_ID } from "@/lib/marketing/types";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260801100000_queue_learn_hub_campaign.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("OpenZaps Learn launch campaign migration", () => {
  const campaigns = (["x", "discord"] as const).map((channel) =>
    reviewedMarketingCampaign(LEARN_HUB_MARKETING_CAMPAIGN_ID, channel),
  );

  it("queues both exact source-reviewed artifacts without an upsert", () => {
    expect(migration).toContain(
      "insert into public.marketing_reviewed_campaigns",
    );
    expect(migration).not.toMatch(/on\s+conflict/iu);
    expect(migration.match(/'learn-hub-launched-v1'/gu)).toHaveLength(2);
    expect(migration).toContain("'x'");
    expect(migration).toContain("'discord'");
    expect(migration).toContain("'2026-08-04T14:00:00.000Z'::timestamptz");

    for (const campaign of campaigns) {
      expect(migration).toContain(campaign.body);
      expect(migration).toContain(`'${campaign.contentHash}'`);
    }
  });

  it("pins every live fact, claim, and canonical source", () => {
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
