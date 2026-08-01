import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260801024005_durable_reviewed_marketing_campaign_queue.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("durable reviewed campaign queue migration", () => {
  it("keeps campaign content and claims inaccessible outside service-role RPCs", () => {
    for (const table of [
      "marketing_reviewed_campaigns",
      "marketing_campaign_schedule_claims",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `alter table public\\.${table} enable row level security`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke all on table public\\.${table}\\s+from public, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(migration).not.toMatch(
        new RegExp(`grant\\s+[^;]*on\\s+(?:table\\s+)?public\\.${table}`, "i"),
      );
    }

    expect(migration).toMatch(
      /create or replace function private\.claim_next_marketing_campaign_at\([\s\S]*?security definer[\s\S]*?set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.claim_next_marketing_campaign\(text\[\]\)\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_next_marketing_campaign\(text\[\]\)\s+to service_role/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.verify_marketing_campaign_schedule_claim\(\s*text, text, date, text\s*\) from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.verify_marketing_campaign_schedule_claim\(\s*text, text, date, text\s*\) to service_role/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.claim_next_marketing_campaign_at\(\s*text\[\], timestamptz\s*\) from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.verify_marketing_campaign_schedule_claim_at\(\s*text, text, date, text, timestamptz\s*\) from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.(?:claim_next_marketing_campaign_at|verify_marketing_campaign_schedule_claim_at)/i,
    );
  });

  it("selects one ordered pending pair before inserting its daily claim", () => {
    const selectAt = migration.indexOf(
      "select campaigns.*\n  into selected_campaign",
    );
    const orderAt = migration.indexOf(
      "order by campaigns.queue_order, campaigns.campaign_id, campaigns.channel",
    );
    const insertAt = migration.indexOf(
      "insert into public.marketing_campaign_schedule_claims",
      orderAt,
    );

    expect(selectAt).toBeGreaterThan(0);
    expect(orderAt).toBeGreaterThan(selectAt);
    expect(insertAt).toBeGreaterThan(orderAt);
    expect(migration).toContain("'no_pending_campaign'::text");
    expect(migration).toContain(
      "not exists (\n      select 1\n      from public.marketing_delivery_ledger",
    );
    expect(migration).toContain("before update or delete or truncate");
    expect(migration).toMatch(
      /create trigger marketing_campaign_schedule_claims_immutable\s+before update or delete or truncate\s+on public\.marketing_campaign_schedule_claims/i,
    );
    expect(migration).toMatch(
      /primary key \(campaign_id, channel, claim_day\)/i,
    );
    expect(migration).not.toMatch(
      /from public\.marketing_campaign_schedule_claims as prior_claim/i,
    );
  });

  it("fails closed if an unexpected preexisting queue could hide seed drift", () => {
    expect(migration).toMatch(
      /create table public\.marketing_reviewed_campaigns/i,
    );
    expect(migration).toMatch(
      /create table public\.marketing_campaign_schedule_claims/i,
    );
    expect(migration).not.toMatch(
      /create table if not exists public\.marketing_(?:reviewed_campaigns|campaign_schedule_claims)/i,
    );
    expect(migration).not.toMatch(/on conflict/i);
  });

  it("starts empty instead of duplicating the already-published product update", () => {
    expect(migration).not.toMatch(
      /insert into public\.marketing_reviewed_campaigns/i,
    );
    expect(migration).toContain("initial release intentionally starts empty");
    expect(migration).toContain("already published to X and Discord");
    expect(migration).not.toContain("virtual-trading-request-zap-v2");
  });

  it("keeps deterministic time injection private and live RPC time authoritative", () => {
    const deterministicClaim = migration.slice(
      migration.indexOf(
        "create or replace function private.claim_next_marketing_campaign_at",
      ),
      migration.indexOf(
        "revoke all on function private.claim_next_marketing_campaign_at",
      ),
    );
    const deterministicVerify = migration.slice(
      migration.indexOf(
        "create or replace function private.verify_marketing_campaign_schedule_claim_at",
      ),
      migration.indexOf(
        "revoke all on function private.verify_marketing_campaign_schedule_claim_at",
      ),
    );

    expect(deterministicClaim).toContain("utc_now := p_now");
    expect(deterministicClaim).not.toContain("clock_timestamp()");
    expect(deterministicVerify).toContain(
      "utc_day := (p_now at time zone 'UTC')::date",
    );
    expect(deterministicVerify).not.toContain("clock_timestamp()");
    expect(migration).toMatch(
      /create or replace function private\.claim_next_marketing_campaign\([\s\S]*?private\.claim_next_marketing_campaign_at\([\s\S]*?pg_catalog\.clock_timestamp\(\)/i,
    );
    expect(migration).toMatch(
      /create or replace function private\.verify_marketing_campaign_schedule_claim\([\s\S]*?private\.verify_marketing_campaign_schedule_claim_at\([\s\S]*?pg_catalog\.clock_timestamp\(\)/i,
    );
  });
});
