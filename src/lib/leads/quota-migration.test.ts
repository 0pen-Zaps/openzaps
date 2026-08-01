import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801082654_increase_lead_shared_network_quota.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("lead shared-network quota migration", () => {
  it("raises the bounded daily ceiling from three to twelve", () => {
    expect(migration).toContain(
      "drop constraint if exists lead_request_quotas_accepted_count_check",
    );
    expect(migration).toContain("check (accepted_count between 1 and 12)");
    expect(migration).toContain("if current_count >= 12 then");
    expect(migration).not.toContain("if current_count >= 3 then");
  });

  it("retains per-fingerprint serialization and the UTC-day window", () => {
    const lockAt = migration.indexOf("openzaps-lead-intake:");
    const dayAt = migration.indexOf("utc_day :=", lockAt);
    const countAt = migration.indexOf(
      "select quotas.accepted_count::integer",
      dayAt,
    );
    const limitAt = migration.indexOf("if current_count >= 12", countAt);
    const quotaInsertAt = migration.indexOf(
      "insert into private.lead_request_quotas",
      limitAt,
    );
    const leadInsertAt = migration.indexOf(
      "insert into private.lead_requests",
      quotaInsertAt,
    );

    expect(lockAt).toBeGreaterThan(0);
    expect(dayAt).toBeGreaterThan(lockAt);
    expect(countAt).toBeGreaterThan(dayAt);
    expect(limitAt).toBeGreaterThan(countAt);
    expect(quotaInsertAt).toBeGreaterThan(limitAt);
    expect(leadInsertAt).toBeGreaterThan(quotaInsertAt);
    expect(migration).toContain(
      "pg_catalog.clock_timestamp() at time zone 'UTC'",
    );
  });

  it("keeps the privileged implementation narrow and service-role-only", () => {
    expect(migration).toMatch(
      /create or replace function private\.submit_lead_request\([\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toMatch(
      /revoke all on function private\.submit_lead_request\([\s\S]*?\) from public, anon, authenticated, service_role/iu,
    );
    expect(migration).toMatch(
      /grant execute on function private\.submit_lead_request\([\s\S]*?\) to service_role/iu,
    );
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete)/iu);
    expect(migration).not.toMatch(/create policy/iu);
  });
});
