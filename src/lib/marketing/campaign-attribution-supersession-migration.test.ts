import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reviewedMarketingCampaign } from "@/lib/marketing/scheduled-template";
import {
  AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
  LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
  LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
} from "@/lib/marketing/types";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260802040522_supersede_untagged_marketing_campaigns.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const REPLACEMENTS = [
  [
    LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
    AGENT_KIT_MARKETING_CAMPAIGN_ID,
    "discord",
  ],
  [
    LEGACY_AGENT_KIT_MARKETING_CAMPAIGN_ID,
    AGENT_KIT_MARKETING_CAMPAIGN_ID,
    "x",
  ],
  [
    LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
    LEARN_HUB_MARKETING_CAMPAIGN_ID,
    "x",
  ],
  [
    LEGACY_LEARN_HUB_MARKETING_CAMPAIGN_ID,
    LEARN_HUB_MARKETING_CAMPAIGN_ID,
    "discord",
  ],
  [
    LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    "discord",
  ],
  [
    LEGACY_SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
    "x",
  ],
] as const;

describe("attributed reviewed campaign supersession migration", () => {
  it("appends every exact attributed artifact before superseding its predecessor", () => {
    const campaignInsert = migration.indexOf(
      "insert into public.marketing_reviewed_campaigns",
    );
    const supersessionInsert = migration.indexOf(
      "insert into public.marketing_reviewed_campaign_supersessions",
    );

    expect(campaignInsert).toBeGreaterThan(0);
    expect(supersessionInsert).toBeGreaterThan(campaignInsert);
    expect(migration).not.toMatch(/on\s+conflict/iu);

    for (const [, replacementId, channel] of REPLACEMENTS) {
      const campaign = reviewedMarketingCampaign(replacementId, channel);
      expect(migration).toContain(campaign.body);
      expect(migration).toContain(`'${campaign.contentHash}'`);
      expect(migration).toContain(campaign.links[0]);
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

  it("records six immutable same-channel supersessions", () => {
    expect(migration).toMatch(
      /create table public\.marketing_reviewed_campaign_supersessions/iu,
    );
    expect(migration).toMatch(
      /check \(superseded_channel = replacement_channel\)/iu,
    );
    for (const [legacyId, replacementId, channel] of REPLACEMENTS) {
      expect(migration).toContain(
        `('${legacyId}', '${channel}', '${replacementId}', '${channel}')`,
      );
    }
    expect(migration).toMatch(
      /alter table public\.marketing_reviewed_campaign_supersessions enable row level security/iu,
    );
    expect(migration).toMatch(
      /revoke all on table public\.marketing_reviewed_campaign_supersessions\s+from public, anon, authenticated, service_role/iu,
    );
    expect(migration).toMatch(
      /create trigger marketing_reviewed_campaign_supersessions_immutable\s+before update or delete or truncate/iu,
    );
    expect(migration).not.toMatch(
      /grant\s+[^;]*on\s+(?:table\s+)?public\.marketing_reviewed_campaign_supersessions/iu,
    );
  });

  it("fails closed before replacement if an old artifact was claimed or delivered", () => {
    const guard = migration.indexOf("do $guard$");
    const campaignInsert = migration.indexOf(
      "insert into public.marketing_reviewed_campaigns",
    );

    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(campaignInsert);
    expect(migration).toContain(
      "from public.marketing_campaign_schedule_claims as schedule_claim",
    );
    expect(migration).toContain(
      "from public.marketing_delivery_ledger as delivery",
    );
    expect(migration).toContain(
      "raise exception 'cannot supersede a claimed or delivered marketing campaign'",
    );
  });

  it("makes the queue skip superseded rows without widening RPC grants", () => {
    expect(migration).toMatch(
      /create or replace function private\.claim_next_marketing_campaign_at\([\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toMatch(
      /not exists \(\s*select 1\s*from public\.marketing_reviewed_campaign_supersessions as supersession\s*where supersession\.superseded_campaign_id = campaigns\.campaign_id\s*and supersession\.superseded_channel = campaigns\.channel\s*\)/iu,
    );
    expect(migration).toMatch(
      /revoke all on function private\.claim_next_marketing_campaign_at\(\s*text\[\], timestamptz\s*\) from public, anon, authenticated, service_role/iu,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.claim_next_marketing_campaign_at/iu,
    );
  });
});
