import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801170000_marketing_x_compliance_operations.sql",
    import.meta.url,
  ),
  "utf8",
);
const retentionSequenceMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801224202_harden_marketing_retention_sequence_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

function privateFunction(name: string, nextName?: string) {
  const start = migration.indexOf(`create or replace function private.${name}`);
  const end = nextName
    ? migration.indexOf(`create or replace function private.${nextName}`, start + 1)
    : migration.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("marketing X compliance operations migration", () => {
  it("removes inherited direct access to the retention identity sequence", () => {
    expect(retentionSequenceMigration).toMatch(
      /revoke all on sequence public\.marketing_x_retention_events_event_id_seq\s+from public, anon, authenticated, service_role;/iu,
    );
    expect(retentionSequenceMigration).not.toMatch(/\bgrant\b/iu);
  });

  it("keeps every new identifier store behind RLS and without direct grants", () => {
    for (const table of [
      "marketing_x_compliance_checkpoints",
      "marketing_x_compliance_subject_observations",
      "marketing_x_reply_subjects",
      "marketing_x_outbound_admissions",
      "marketing_x_retention_events",
    ]) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table}[\\s\\S]*?enable row level security`, "i"),
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

  it("exposes only service-role wrappers for every new operation", () => {
    for (const name of [
      "list_marketing_x_compliance_subjects",
      "record_marketing_x_compliance_checkpoint",
      "get_marketing_x_compliance_health",
      "create_marketing_x_reply_subject",
      "get_marketing_x_reply_subject",
      "claim_marketing_x_reply_subject_admission",
      "admit_marketing_x_outbound_delivery",
      "check_marketing_x_outbound_admission",
      "finalize_marketing_x_outbound_admission",
      "purge_marketing_x_retention",
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

  it("makes the first activation cutoff immutable and baselines delayed posts", () => {
    expect(migration).toContain("eligibility_cutoff_at timestamptz");
    expect(migration).toContain("marketing X eligibility cutoff is immutable");
    expect(migration).toContain("new.source_created_at <= cutoff");
    expect(migration).toContain("new.state := 'baseline'");
    expect(migration).toContain(
      "mentions.source_created_at > current_account.eligibility_cutoff_at",
    );
    expect(migration).toContain("before insert on public.marketing_x_mentions");
  });

  it("derives readiness from one recent complete official lookup checkpoint", () => {
    const record = privateFunction(
      "record_marketing_x_compliance_checkpoint",
      "create_marketing_x_reply_subject",
    );
    const health = privateFunction(
      "get_marketing_x_compliance_health",
      "admit_marketing_x_outbound_delivery",
    );
    expect(migration).toContain("source_kind text not null default 'official_lookup'");
    expect(record).toContain("'coverage_conflict'::text");
    expect(record).toContain("p_started_at < recorded_now - interval '10 minutes'");
    expect(record).toContain("p_completed_at + interval '30 minutes'");
    expect(record).toContain("marketing_x_compliance_subject_observations");
    expect(health).toContain("private.marketing_x_compliance_is_fresh");
    expect(health).toContain("then 'healthy'::text");
    expect(health).toContain("else 'stale'::text");
    expect(migration).not.toContain("OPENZAPS_X_COMPLIANCE_READY");
  });

  it("requires current post and author observations before an automatic claim", () => {
    const claim = privateFunction(
      "claim_next_marketing_x_mention",
      "clear_marketing_x_compliance_hold",
    );
    expect(claim).toContain("private.marketing_x_subject_is_covered");
    expect(claim).toContain("'post'");
    expect(claim).toContain("'author'");
    expect(claim).toContain("'subject_compliance_stale'::text");
    expect(claim).toContain("current_account.compliance_hold_at is not null");
    expect(claim).toContain("private.marketing_x_compliance_is_fresh");
  });

  it("keeps manual targets opaque outside one short provider-boundary claim", () => {
    const tableStart = migration.indexOf("create table if not exists public.marketing_x_reply_subjects");
    const tableEnd = migration.indexOf("create index if not exists marketing_x_reply_subjects_expiry");
    const table = migration.slice(tableStart, tableEnd);
    const create = privateFunction(
      "create_marketing_x_reply_subject",
      "get_marketing_x_reply_subject",
    );
    const get = privateFunction(
      "get_marketing_x_reply_subject",
      "claim_marketing_x_reply_subject_admission",
    );
    const claim = privateFunction(
      "claim_marketing_x_reply_subject_admission",
      "get_marketing_x_compliance_health",
    );

    expect(table).toContain("expires_at = created_at + interval '24 hours'");
    expect(table).toContain("interaction_reference text primary key");
    expect(create.slice(create.indexOf("returns table"), create.indexOf("language plpgsql"))).not.toMatch(
      /post_id text|author_id text|target_url text/,
    );
    expect(get.slice(get.indexOf("returns table"), get.indexOf("language plpgsql"))).not.toMatch(
      /post_id text|author_id text|target_url text/,
    );
    expect(claim.slice(claim.indexOf("returns table"), claim.indexOf("language plpgsql"))).toContain(
      "target_url text",
    );
    expect(claim).toContain("'already_claimed'::text");
    expect(claim).toContain("null::text");
  });

  it("uses a hold-aware ten-second final admission fence", () => {
    const admit = privateFunction(
      "admit_marketing_x_outbound_delivery",
      "check_marketing_x_outbound_admission",
    );
    const check = privateFunction(
      "check_marketing_x_outbound_admission",
      "finalize_marketing_x_outbound_admission",
    );
    expect(admit).toContain("admission_time + interval '10 seconds'");
    expect(admit).toContain("p_provider_checked_at < admission_time - interval '2 minutes'");
    expect(admit).toContain("'subject_compliance_stale'::text");
    expect(check).toContain("'compliance_hold'");
    expect(check).toContain("'compliance_stale'");
    expect(check).toContain("state = 'revoked'");
    expect(migration).toContain("marketing_x_compliance_hold_admission_fence");
  });

  it("sets the hold and rewrites raw delivery bindings before erasure", () => {
    const erase = privateFunction(
      "erase_marketing_x_compliance_data",
      "purge_marketing_x_retention",
    );
    const holdAt = erase.indexOf("compliance_hold_at = coalesce");
    const rewriteAt = erase.indexOf("set interaction_id = affected.interaction_reference");
    const mentionDeleteAt = erase.indexOf("delete from public.marketing_x_mentions");
    expect(holdAt).toBeGreaterThanOrEqual(0);
    expect(rewriteAt).toBeGreaterThan(holdAt);
    expect(mentionDeleteAt).toBeGreaterThan(rewriteAt);
    expect(erase).toContain("marketing_x_compliance_subject_observations");
    expect(migration).toContain("failure_code = 'compliance_hold'");
  });

  it("enforces finite raw-identifier and evidence retention", () => {
    const purge = privateFunction("purge_marketing_x_retention");
    expect(purge).toContain("reply_subjects.expires_at <= p_now");
    expect(purge).toContain("claim_expires_at <= p_now");
    expect(purge).toContain("interval '30 days'");
    expect(purge).toContain("interval '90 days'");
    expect(purge).toContain("interval '7 days'");
    expect(purge).toContain("interval '365 days'");
    expect(purge).toContain("last_defer_reason = 'retention_rebaseline'");
  });
});
