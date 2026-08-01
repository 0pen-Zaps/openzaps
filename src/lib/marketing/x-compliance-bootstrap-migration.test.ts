import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801221910_marketing_x_compliance_bootstrap.sql",
    import.meta.url,
  ),
  "utf8",
);

function privateFunction(name: string, nextMarker: string): string {
  const start = migration.indexOf(`create or replace function private.${name}`);
  const end = migration.indexOf(nextMarker, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("marketing X compliance bootstrap migration", () => {
  it("is append-only and exposes a service-role-only wrapper", () => {
    expect(migration).not.toMatch(/^\s*(?:begin|commit)\s*;/imu);
    expect(migration).toMatch(
      /create or replace function private\.initialize_marketing_x_compliance_account\([\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toMatch(
      /create or replace function public\.initialize_marketing_x_compliance_account\([\s\S]*?security invoker[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toMatch(
      /revoke all on function public\.initialize_marketing_x_compliance_account\([\s\S]*?from public, anon, authenticated, service_role/iu,
    );
    expect(migration).toMatch(
      /grant execute on function public\.initialize_marketing_x_compliance_account\([\s\S]*?to service_role/iu,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)[^;]*marketing_x_/iu,
    );
  });

  it("creates only an immutable account cutoff from a recent identity proof", () => {
    const initialize = privateFunction(
      "initialize_marketing_x_compliance_account",
      "revoke all on function private.initialize_marketing_x_compliance_account",
    );
    expect(initialize).toContain("p_verified_at < boundary_at - interval '10 minutes'");
    expect(initialize).toContain("p_verified_at > boundary_at + interval '1 minute'");
    expect(initialize).toContain("openzaps-marketing-x-compliance:");
    const lock = initialize.indexOf("pg_advisory_xact_lock");
    const refreshedClock = initialize.indexOf(
      "boundary_at := pg_catalog.clock_timestamp()",
      lock,
    );
    const freshnessCheck = initialize.indexOf(
      "p_verified_at < boundary_at - interval '10 minutes'",
    );
    const insert = initialize.indexOf(
      "insert into public.marketing_x_mention_accounts",
    );
    expect(refreshedClock).toBeGreaterThan(lock);
    expect(freshnessCheck).toBeGreaterThan(refreshedClock);
    expect(insert).toBeGreaterThan(freshnessCheck);
    expect(initialize).toMatch(
      /insert into public\.marketing_x_mention_accounts \(\s*account_id,\s*eligibility_cutoff_at,\s*next_poll_at,\s*created_at,\s*updated_at\s*\)/iu,
    );
    expect(initialize).toContain(
      "on conflict on constraint marketing_x_mention_accounts_pkey do nothing",
    );
    expect(initialize).not.toMatch(
      /initialized_at|since_id|cursor_set_at|poll_lease|marketing_x_mentions|marketing_x_reply_subjects|marketing_x_outbound_admissions/iu,
    );
    expect(initialize).not.toMatch(/\bupdate\b|\bdelete\b|\btruncate\b/iu);
  });

  it("requires a fresh checkpoint but not a fabricated mention baseline", () => {
    const health = privateFunction(
      "get_marketing_x_compliance_health",
      "revoke all on function private.get_marketing_x_compliance_health",
    );
    const fresh = health.indexOf("private.marketing_x_compliance_is_fresh");
    const notInitialized = health.indexOf("current_account.initialized_at is null");
    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(notInitialized).toBeGreaterThan(fresh);
    expect(health).toContain("then 'healthy'::text");
    expect(health).toContain("then 'not_initialized'::text");
  });
});
