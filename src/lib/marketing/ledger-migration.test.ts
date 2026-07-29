import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260729035549_marketing_delivery_ledger.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("marketing delivery ledger migration", () => {
  it("keeps the table behind RLS with no direct Data API role access", () => {
    expect(migration).toMatch(
      /alter table public\.marketing_delivery_ledger enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.marketing_delivery_ledger\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)[^;]*on\s+(?:table\s+)?public\.marketing_delivery_ledger/i,
    );
  });

  it("keeps privileged implementations private and exposes invoker wrappers only to service_role", () => {
    for (const name of [
      "claim_marketing_delivery",
      "get_marketing_delivery_snapshot",
      "complete_marketing_delivery_claim",
      "claim_marketing_schedule_slot",
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

  it("keeps deterministic schedule slots behind RLS with no direct role grants", () => {
    expect(migration).toMatch(
      /create table if not exists public\.marketing_schedule_slots[\s\S]*?primary key \(schedule_key, slot_day\)/i,
    );
    expect(migration).toMatch(
      /alter table public\.marketing_schedule_slots enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.marketing_schedule_slots\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)[^;]*on\s+(?:table\s+)?public\.marketing_schedule_slots/i,
    );
  });

  it("atomically derives one weekday product-update slot from the database UTC date", () => {
    const scheduleFunction = migration.slice(
      migration.indexOf(
        "create or replace function private.claim_marketing_schedule_slot_for_day(",
      ),
    );

    expect(scheduleFunction).toContain(
      "pg_catalog.clock_timestamp() at time zone 'UTC'",
    );
    expect(scheduleFunction).toContain(
      "extract(isodow from p_slot_day) not between 1 and 5",
    );
    expect(scheduleFunction).toContain("'weekday_product_update'");
    expect(scheduleFunction).toContain(
      "on conflict on constraint marketing_schedule_slots_pkey do nothing",
    );
    expect(scheduleFunction).toContain("'already_claimed'::text");
    expect(scheduleFunction).toContain("'outside_schedule'::text");
    expect(scheduleFunction).not.toMatch(
      /delete from public\.marketing_schedule_slots/i,
    );
  });

  it("serializes claims before checking exact daily caps", () => {
    const lockAt = migration.indexOf("openzaps-marketing-delivery-global");
    const dayAt = migration.indexOf("utc_day :=", lockAt);
    const countAt = migration.indexOf("select count(*)::integer", lockAt);
    const capAt = migration.indexOf("if used_count >= p_daily_cap", countAt);
    const insertAt = migration.indexOf("insert into public.marketing_delivery_ledger", capAt);

    expect(lockAt).toBeGreaterThan(0);
    expect(dayAt).toBeGreaterThan(lockAt);
    expect(countAt).toBeGreaterThan(dayAt);
    expect(capAt).toBeGreaterThan(countAt);
    expect(insertAt).toBeGreaterThan(capAt);
    expect(migration).toContain("p_daily_cap not between 0 and 100");
  });

  it("enforces one lifetime automated X reply per interaction", () => {
    expect(migration).toMatch(
      /create unique index if not exists marketing_delivery_one_x_reply\s+on public\.marketing_delivery_ledger \(interaction_id\)\s+where channel = 'x' and action = 'reply'/i,
    );
    expect(migration).toContain("'interaction_already_claimed'::text");
    expect(migration).toContain("p_interaction_id ~ '^[0-9]{1,30}$'");
  });

  it("retains failed and ambiguous claims instead of creating a retry path", () => {
    expect(migration).toContain("'claimed'");
    expect(migration).toContain("'failed'");
    expect(migration).not.toMatch(/delete from public\.marketing_delivery_ledger/i);
    expect(migration).not.toMatch(/grant\s+delete[^;]*marketing_delivery_ledger/i);
  });

  it("admits only channel/action pairs with deployed delivery adapters", () => {
    expect(migration).not.toContain("'direct_message'");
    expect(migration).not.toContain("'publish_tutorial'");
    expect(migration).not.toMatch(
      /p_channel = 'discord'\s+and p_action (?:=|in \()'reply'/i,
    );
    expect(migration).toContain(
      "p_channel = 'substack'\n      and p_action = 'prepare_tutorial'",
    );
  });

  it("binds terminal receipts to their claimed channel and canonical provider shape", () => {
    const completionFunction = migration.slice(
      migration.indexOf(
        "create or replace function private.complete_marketing_delivery_claim(",
      ),
      migration.indexOf(
        "create or replace function public.complete_marketing_delivery_claim(",
      ),
    );

    expect(completionFunction).toContain("current_row.channel <> p_channel");
    expect(completionFunction).toContain("current_row.action <> p_action");
    expect(completionFunction).toContain(
      "'https://x.com/i/web/status/' || p_provider_message_id",
    );
    expect(completionFunction).toContain(
      "'https://defitutorials.substack.com/publish/post'",
    );
    expect(completionFunction).toContain(
      "p_provider_message_id ~ '^[0-9]{1,30}$'",
    );
    expect(migration).toContain(
      "status = 'published'\n      and provider_message_id is not null",
    );
    expect(migration).toContain(
      "status = 'requires_human_publish'\n      and provider_message_id is null\n      and provider_url is not null",
    );
  });

  it("redacts receipt metadata from idempotency conflicts", () => {
    const conflictAt = migration.indexOf("'idempotency_conflict'::text");
    const conflictResult = migration.slice(
      conflictAt,
      migration.indexOf("return;", conflictAt),
    );

    expect(conflictAt).toBeGreaterThan(0);
    expect(conflictResult).not.toContain("current_row.provider_message_id");
    expect(conflictResult).not.toContain("current_row.provider_url");
    expect(conflictResult).not.toContain("current_row.claimed_at");
  });

  it("returns durable receipt and reconciliation metadata on claim replay", () => {
    for (const field of [
      "provider_message_id text",
      "provider_url text",
      "failure_code text",
      "claimed_at timestamptz",
      "completed_at timestamptz",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("current_row.provider_message_id");
    expect(migration).toContain("current_row.finalized_at");
  });
});
