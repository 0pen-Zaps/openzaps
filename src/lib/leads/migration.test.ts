import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260730020106_private_lead_intake.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("private lead intake migration", () => {
  it("keeps lead, quota, and audit data private with no direct role grants", () => {
    for (const table of [
      "lead_request_quotas",
      "lead_requests",
      "lead_request_lifecycle_events",
    ]) {
      expect(migration).toMatch(
        new RegExp(`create table if not exists private\\.${table}`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(
          `alter table private\\.${table} enable row level security`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke all on table private\\.${table}\\s+from public, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(migration).not.toMatch(
        new RegExp(
          `grant\\s+(?:select|insert|update|delete|truncate)[^;]*private\\.${table}`,
          "i",
        ),
      );
    }
    expect(migration).not.toMatch(/create policy/i);
  });

  it("exposes narrow invoker wrappers only to service_role", () => {
    for (const name of [
      "submit_lead_request",
      "list_lead_requests",
      "update_lead_request_lifecycle",
      "delete_lead_request",
      "purge_expired_lead_requests",
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

  it("serializes each fingerprint before deriving and enforcing the UTC quota", () => {
    const lockAt = migration.indexOf("openzaps-lead-intake:");
    const dayAt = migration.indexOf("utc_day :=", lockAt);
    const countAt = migration.indexOf(
      "select quotas.accepted_count::integer",
      dayAt,
    );
    const quotaAt = migration.indexOf("if current_count >= 3", countAt);
    const quotaInsertAt = migration.indexOf(
      "insert into private.lead_request_quotas",
      quotaAt,
    );
    const leadInsertAt = migration.indexOf(
      "insert into private.lead_requests",
      quotaAt,
    );

    expect(lockAt).toBeGreaterThan(0);
    expect(dayAt).toBeGreaterThan(lockAt);
    expect(countAt).toBeGreaterThan(dayAt);
    expect(quotaAt).toBeGreaterThan(countAt);
    expect(quotaInsertAt).toBeGreaterThan(quotaAt);
    expect(leadInsertAt).toBeGreaterThan(quotaInsertAt);
    expect(migration).toContain(
      "pg_catalog.clock_timestamp() at time zone 'UTC'",
    );
  });

  it("isolates pseudonymous quota data from contact and workflow records", () => {
    const leadTable = migration.slice(
      migration.indexOf("create table if not exists private.lead_requests ("),
      migration.indexOf(
        "alter table private.lead_requests enable row level security",
      ),
    );
    expect(leadTable).not.toContain("fingerprint");
    expect(leadTable).not.toContain("received_day");
    expect(migration).toContain(
      "primary key (client_fingerprint, received_day)",
    );
    expect(migration).toContain(
      "expires_at <= created_at + interval '2 days'",
    );
  });

  it("records scoped consent and never client-enrolls marketing or email verification", () => {
    expect(migration).toContain("'lead-contact-v1'");
    expect(migration).toContain("marketing_opt_in boolean not null default false");
    expect(migration).toContain("check (marketing_opt_in is false)");
    expect(migration).toContain("email_verified boolean not null default false");
    const submitSignature = migration.slice(
      migration.indexOf(
        "create or replace function private.submit_lead_request(",
      ),
      migration.indexOf("returns table", migration.indexOf(
        "create or replace function private.submit_lead_request(",
      )),
    );
    expect(submitSignature).not.toContain("email_verified");
  });

  it("uses finite audited lifecycle retention with a one-year hard cap", () => {
    expect(migration).toContain("updated_at timestamptz not null");
    expect(migration).toContain("accepted_at + interval '180 days'");
    expect(migration).toContain(
      "expires_at <= created_at + interval '365 days'",
    );
    expect(migration).toContain(
      "expires_at <= updated_at + interval '30 days'",
    );
    expect(migration).not.toContain("active_engagement");
    expect(migration).toContain(
      "create table if not exists private.lead_request_lifecycle_events",
    );
    expect(migration).toContain(
      "insert into private.lead_request_lifecycle_events",
    );
    expect(migration).toContain(
      "previous_status = 'qualified' and p_status = 'closed'",
    );
    expect(migration).toContain("when p_status = 'closed' then interval '30 days'");
  });

  it("purges expired leads and short-lived quota rows every retention run", () => {
    expect(migration).toContain(
      "delete from private.lead_requests as leads",
    );
    expect(migration).toContain(
      "leads.expires_at <= pg_catalog.clock_timestamp()",
    );
    expect(migration).toContain(
      "delete from private.lead_request_quotas as quotas",
    );
    expect(migration).toContain(
      "quotas.expires_at <= pg_catalog.clock_timestamp()",
    );
  });

  it("returns lifecycle and email verification state but never a quota fingerprint", () => {
    const listFunction = migration.slice(
      migration.indexOf(
        "create or replace function private.list_lead_requests(",
      ),
    );
    const returnedColumns = listFunction.slice(
      listFunction.indexOf("returns table"),
      listFunction.indexOf("language plpgsql"),
    );
    expect(returnedColumns).not.toContain("fingerprint");
    expect(returnedColumns).toContain("email_verified boolean");
    expect(returnedColumns).toContain("updated_at timestamptz");
  });
});
