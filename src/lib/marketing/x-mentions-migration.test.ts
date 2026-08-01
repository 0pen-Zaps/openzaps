import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801143000_marketing_x_mentions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("marketing X mention persistence migration", () => {
  it("keeps all metadata tables behind RLS without direct Data API grants", () => {
    for (const table of [
      "marketing_x_mention_accounts",
      "marketing_x_mentions",
      "marketing_x_mention_opt_outs",
      "marketing_x_compliance_events",
    ]) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke all on table public\\.${table}\\s+from public, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(migration).not.toMatch(
        new RegExp(
          `grant\\s+(?:select|insert|update|delete|truncate)[^;]*public\\.${table}`,
          "i",
        ),
      );
    }
  });

  it("exposes only service-role invoker RPCs over private definer implementations", () => {
    for (const name of [
      "claim_marketing_x_mention_poll",
      "commit_marketing_x_mention_discovery",
      "defer_marketing_x_mention_poll",
      "list_marketing_x_mention_inbox",
      "claim_next_marketing_x_mention",
      "complete_marketing_x_mention_reply",
      "fail_marketing_x_mention_reply",
      "record_marketing_x_mention_opt_out",
      "erase_marketing_x_compliance_data",
      "clear_marketing_x_compliance_hold",
      "get_marketing_x_interaction_reference",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create or replace function private\\.${name}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `create or replace function public\\.${name}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = ''`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function public\\.${name}\\([\\s\\S]*?\\)\\s+from public, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant execute on function public\\.${name}\\([\\s\\S]*?\\)\\s+to service_role`,
          "i",
        ),
      );
    }
  });

  it("stores only bounded IDs, timestamps, content HMAC, and machine codes", () => {
    const table = migration.slice(
      migration.indexOf("create table public.marketing_x_mentions"),
      migration.indexOf("create unique index marketing_x_mentions_one_author_reply_per_day"),
    );
    for (const field of [
      "post_id text not null unique",
      "author_id text not null",
      "conversation_id text not null",
      "source_created_at timestamptz not null",
      "content_hmac text not null",
      "delivery_reference uuid not null unique default pg_catalog.gen_random_uuid()",
      "interaction_reference text not null unique",
      "classification text not null",
      "eligibility_reason text not null",
    ]) {
      expect(table).toContain(field);
    }
    expect(table).not.toMatch(
      /\b(?:post_text|raw_text|body|username|display_name|profile|media|url|email|phone|ip_address|wallet)\b/i,
    );
    expect(migration).toContain(") <> 7");
    expect(table).toContain(
      "default private.marketing_x_random_interaction_reference()",
    );
    expect(table).toContain("check (interaction_reference ~ '^[1-9][0-9]{29}$')");
    expect(migration).toContain("check (post_id ~ '^[1-9][0-9]{0,18}$')");
    expect(migration).not.toMatch(
      /entries\.item\s*\?&\s*array\[[\s\S]*?'(?:text|body|username|display_name|media|url)'/i,
    );
  });

  it("uses a lease-bound first-run baseline and advances only completed pages", () => {
    expect(migration).toContain("current_account.initialized_at is null");
    expect(migration).toContain("when was_baseline then 'baseline'");
    expect(migration).toContain("poll_lease_expires_at = claimed_at + interval '5 minutes'");
    expect(migration).toContain("if p_completed then");
    expect(migration).toContain(
      "since_id = coalesce(p_next_since_id, accounts.since_id)",
    );
    expect(migration).toContain("'partial_committed'::text");
    expect(migration).toContain("then 'baseline_empty'::text");
    expect(migration).toContain("continuation_until_id = p_next_continuation_until_id");
    expect(migration).toContain(
      "current_account.continuation_until_id is distinct from p_previous_continuation_until_id",
    );
    expect(migration).toContain(
      "current_account.continuation_newest_id is distinct from p_next_since_id",
    );
    expect(migration).toContain("current_account.since_id is distinct from p_previous_since_id");
    expect(migration).toContain("current_account.poll_lease_token is distinct from p_lease_token");
    expect(migration).toContain("item_count not between 0 and 500");
    expect(migration).toContain("on conflict (post_id) do nothing");
  });

  it("holds polling after compliance erasure until official absence is verified", () => {
    const erase = migration.slice(
      migration.indexOf("create or replace function private.erase_marketing_x_compliance_data"),
      migration.indexOf("create or replace function public.erase_marketing_x_compliance_data"),
    );
    const clear = migration.slice(
      migration.indexOf("create or replace function private.clear_marketing_x_compliance_hold"),
      migration.indexOf("create or replace function public.clear_marketing_x_compliance_hold"),
    );
    const claim = migration.slice(
      migration.indexOf("create or replace function private.claim_marketing_x_mention_poll"),
      migration.indexOf("create or replace function public.claim_marketing_x_mention_poll"),
    );

    expect(erase).toContain("compliance_hold_at = erased_at");
    expect(erase).toContain("compliance_hold_reason = p_reason");
    expect(erase).toContain("last_defer_reason = 'compliance_hold'");
    expect(claim).toContain("if current_account.compliance_hold_at is not null then");
    expect(claim).toContain("'compliance_hold'::text");
    expect(clear).toContain("p_verification_code <> 'official_source_absence_verified'");
    expect(clear).toContain("compliance_hold_at = null");
    expect(clear).toContain("compliance_hold_reason = null");
  });

  it("maps manual and automatic reply lanes to one DB-generated interaction reference", () => {
    const lookup = migration.slice(
      migration.indexOf("create or replace function private.get_marketing_x_interaction_reference"),
      migration.indexOf("create or replace function public.get_marketing_x_interaction_reference"),
    );
    const erase = migration.slice(
      migration.indexOf("create or replace function private.erase_marketing_x_compliance_data"),
      migration.indexOf("create or replace function public.erase_marketing_x_compliance_data"),
    );

    expect(lookup).toContain("select mentions.interaction_reference");
    expect(lookup).toContain("mentions.post_id = p_post_id");
    expect(erase).toContain("set interaction_id = mentions.interaction_reference");
    expect(erase).toContain("and ledger.interaction_id = mentions.post_id");
  });

  it("persists bounded deferrals without rewriting last success", () => {
    const defer = migration.slice(
      migration.indexOf("create or replace function private.defer_marketing_x_mention_poll"),
      migration.indexOf("create or replace function public.defer_marketing_x_mention_poll"),
    );
    expect(defer).toContain("p_next_poll_at < defer_time + interval '15 seconds'");
    expect(defer).toContain("p_next_poll_at > defer_time + interval '1 day'");
    expect(defer).toContain("last_defer_reason = p_reason");
    expect(defer).toContain("poll_lease_token = null");
    expect(defer).not.toMatch(/last_success_at\s*=/i);
  });

  it("enforces terminal reply claims, opt-outs, daily caps, and daily uniqueness", () => {
    expect(migration).toContain(
      "marketing_x_mentions_one_author_reply_per_day",
    );
    expect(migration).toContain(
      "marketing_x_mentions_one_conversation_reply_per_day",
    );
    expect(migration).toContain("p_daily_cap not between 0 and 5");
    expect(migration).toContain("'daily_cap_reached'::text");
    expect(migration).toContain(
      "old.state = 'claimed' and new.state in ('replied', 'failed')",
    );
    expect(migration).not.toMatch(/old\.state = '(?:replied|failed)'/);
    expect(migration).toContain("marketing X mention evidence is append-only");
    expect(migration).toContain("marketing_x_mention_opt_outs");
    expect(migration).toContain("mentions.state in ('eligible', 'review_required')");
  });

  it("lists only bounded metadata and excludes the first-run baseline", () => {
    const list = migration.slice(
      migration.indexOf("create or replace function private.list_marketing_x_mention_inbox"),
      migration.indexOf("create or replace function public.list_marketing_x_mention_inbox"),
    );
    expect(list).toContain("p_limit not between 1 and 100");
    expect(list).toContain("mentions.state <> 'baseline'");
    expect(list).toContain("review_required_count integer");
    expect(list).not.toMatch(/jsonb_build_object\([\s\S]*?'(?:text|username|display_name|media|url)'/i);
  });
});
