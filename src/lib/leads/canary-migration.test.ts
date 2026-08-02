import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260802090451_lead_intake_rollback_canary.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("lead-intake rollback canary migration", () => {
  it("runs the public production wrapper with fixed synthetic input", () => {
    expect(migration).toMatch(
      /create or replace function private\.probe_lead_intake_write_path\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
    );
    expect(migration).toContain("from public.submit_lead_request(");
    expect(migration).toContain("pg_catalog.to_regprocedure(");
    expect(migration).toContain("pg_catalog.has_function_privilege(");
    expect(migration).toContain("pg_catalog.has_schema_privilege(");
    expect(migration).toContain(
      "private.submit_lead_request(text,text,text,text,text,text,text,text,text,text,text,boolean,jsonb,integer)",
    );
    expect(migration).toContain("pg_catalog.gen_random_uuid()");
    expect(migration).toContain("@openzaps.invalid");
    expect(migration).toContain("p_consent_to_contact => true");
    expect(migration).not.toMatch(/\bp_[a-z_]+\s+(?:text|uuid|jsonb|boolean|integer)\b/iu);
  });

  it("documents the expected non-transactional identity-sequence advance", () => {
    expect(migration).toMatch(
      /lifecycle-event identity sequence[\s\S]*?sequence values are non-transactional/iu,
    );
  });

  it("asserts every transient effect before the uncaught rollback exception", () => {
    const quotaAt = migration.indexOf("from private.lead_request_quotas");
    const leadAt = migration.indexOf("from private.lead_requests");
    const lifecycleAt = migration.indexOf(
      "from private.lead_request_lifecycle_events",
    );
    const outboxAt = migration.indexOf(
      "from private.lead_notification_outbox",
    );
    const rollbackAt = migration.indexOf(
      "OPENZAPS_LEAD_INTAKE_CANARY_ROLLED_BACK",
    );

    expect(quotaAt).toBeGreaterThan(0);
    expect(leadAt).toBeGreaterThan(quotaAt);
    expect(lifecycleAt).toBeGreaterThan(leadAt);
    expect(outboxAt).toBeGreaterThan(lifecycleAt);
    expect(rollbackAt).toBeGreaterThan(outboxAt);
    expect(migration).toContain("errcode = 'PZC01'");
    expect(migration).toContain("errcode = 'PZC02'");
    expect(migration).not.toMatch(/\bexception\s+when\b/iu);
  });

  it("exposes only a service-role invoker wrapper and no table grants", () => {
    expect(migration).toMatch(
      /create or replace function public\.probe_lead_intake_write_path\(\)[\s\S]*?security invoker[\s\S]*?set search_path = ''/iu,
    );
    for (const schema of ["private", "public"]) {
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function ${schema}\\.probe_lead_intake_write_path\\(\\)\\s+from public, anon, authenticated, service_role`,
          "iu",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant execute on function ${schema}\\.probe_lead_intake_write_path\\(\\)\\s+to service_role`,
          "iu",
        ),
      );
    }
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)/iu,
    );
    expect(migration).not.toMatch(/create policy/iu);
  });
});
