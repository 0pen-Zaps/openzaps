import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENT_KIT_MARKETING_CAMPAIGN_ID } from "@/lib/marketing/types";
import { reviewedMarketingCampaign } from "@/lib/marketing/scheduled-template";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260802010000_queue_agent_kit_x_campaign.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("Agent Kit X campaign migration", () => {
  const campaign = reviewedMarketingCampaign(
    AGENT_KIT_MARKETING_CAMPAIGN_ID,
    "x",
  );

  it("queues the exact source-reviewed X artifact once", () => {
    expect(migration).toContain("insert into public.marketing_reviewed_campaigns");
    expect(migration).toContain(`'${campaign.id}'`);
    expect(migration).toContain("'x'");
    expect(migration).toContain("\n  21,\n");
    expect(migration).not.toMatch(/'discord'\s*,/u);
    expect(migration).toContain(campaign.body);
    expect(migration).toContain(`'${campaign.contentHash}'`);
    expect(migration).toContain("'2026-08-05T14:00:00.000Z'::timestamptz");
    expect(migration).not.toMatch(/on\s+conflict/iu);
  });

  it("pins every required fact, claim, and canonical source", () => {
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
  });
});
