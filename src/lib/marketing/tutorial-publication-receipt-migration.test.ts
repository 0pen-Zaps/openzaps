import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260802063540_marketing_tutorial_publication_receipts.sql",
    import.meta.url,
  ),
  "utf8",
);

const table = migration.slice(
  migration.indexOf(
    "create table public.marketing_tutorial_publication_receipts",
  ),
  migration.indexOf(
    "alter table public.marketing_tutorial_publication_receipts",
  ),
);

const writer = migration.slice(
  migration.indexOf(
    "create or replace function private.record_marketing_tutorial_publication_receipt(",
  ),
  migration.indexOf(
    "revoke all on function private.record_marketing_tutorial_publication_receipt(",
  ),
);

describe("marketing tutorial publication receipt migration", () => {
  it("keeps immutable publication evidence behind RLS without direct grants", () => {
    expect(migration).toMatch(
      /alter table public\.marketing_tutorial_publication_receipts\s+enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.marketing_tutorial_publication_receipts\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)[^;]*public\.marketing_tutorial_publication_receipts/i,
    );
    expect(migration).toMatch(
      /create trigger marketing_tutorial_publication_receipts_immutable\s+before update or delete or truncate\s+on public\.marketing_tutorial_publication_receipts/i,
    );
    expect(migration).toContain(
      "marketing tutorial publication receipts are immutable",
    );
  });

  it("stores only bounded source and public RSS metadata", () => {
    expect(migration).toContain(
      "create table public.marketing_tutorial_publication_receipts",
    );
    expect(migration).not.toContain(
      "create table if not exists public.marketing_tutorial_publication_receipts",
    );
    expect(table).toContain("tutorial_id text primary key");
    expect(table).toContain(
      "source_path = 'docs/tutorials/' || tutorial_id || '.md'",
    );
    expect(table).toContain("source_sha256 ~ '^[0-9a-f]{64}$'");
    expect(table).toContain("body_sha256 ~ '^[0-9a-f]{64}$'");
    expect(table).toContain(
      "canonical_url ~ '^https://defitutorials[.]substack[.]com/p/",
    );
    expect(table).toContain(
      "feed_url = 'https://defitutorials.substack.com/feed'",
    );
    expect(table).toContain("rss_checked_at >= published_at");
    expect(table).toContain(
      "constraint marketing_tutorial_publication_receipts_canonical_url_key\n    unique (canonical_url)",
    );
    expect(table).toContain(
      "constraint marketing_tutorial_publication_receipts_workflow_candidate_key\n    unique (run_id, candidate_id)",
    );
    expect(table).not.toMatch(
      /\b(?:email|subscriber|author|wallet|fingerprint|ip_address|request_headers?|cookie)\b/i,
    );
  });

  it("exposes one service-role invoker RPC over a private definer writer", () => {
    expect(migration).toMatch(
      /create or replace function private\.record_marketing_tutorial_publication_receipt\([\s\S]*?security definer[\s\S]*?set search_path = ''/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.record_marketing_tutorial_publication_receipt\([\s\S]*?security invoker[\s\S]*?set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_marketing_tutorial_publication_receipt\([\s\S]*?\) from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_marketing_tutorial_publication_receipt\([\s\S]*?\) to service_role/i,
    );
  });

  it("binds the RPC to the exact reviewed tuple and persisted result shape", () => {
    for (const parameter of [
      "p_tutorial_id text",
      "p_run_id text",
      "p_candidate_id text",
      "p_source_path text",
      "p_source_sha256 text",
      "p_body_sha256 text",
      "p_approved_title text",
      "p_canonical_url text",
      "p_feed_url text",
      "p_published_at timestamptz",
      "p_rss_checked_at timestamptz",
    ]) {
      expect(writer).toContain(parameter);
    }
    for (const field of [
      "result_code text",
      "tutorial_id text",
      "run_id text",
      "candidate_id text",
      "source_path text",
      "source_sha256 text",
      "body_sha256 text",
      "approved_title text",
      "canonical_url text",
      "feed_url text",
      "published_at timestamptz",
      "rss_checked_at timestamptz",
      "recorded_at timestamptz",
    ]) {
      expect(writer).toContain(field);
    }
    expect(writer).toContain(
      "p_source_path <> 'docs/tutorials/' || p_tutorial_id || '.md'",
    );
    expect(writer).toContain(
      "p_feed_url <> 'https://defitutorials.substack.com/feed'",
    );
    expect(writer).toContain("p_rss_checked_at < p_published_at");
  });

  it("serializes first write, replays exact tuples, and fails conflicts closed", () => {
    const lockAt = writer.indexOf("pg_catalog.pg_advisory_xact_lock");
    const readAt = writer.indexOf(
      "from public.marketing_tutorial_publication_receipts as receipts",
    );
    const insertAt = writer.indexOf(
      "insert into public.marketing_tutorial_publication_receipts",
    );

    expect(lockAt).toBeGreaterThan(0);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(readAt);
    expect(writer).toContain("outcome := 'already_recorded'");
    expect(writer).toContain("outcome := 'conflict'");
    expect(writer).toContain("outcome := 'recorded'");
    for (const field of [
      "run_id",
      "candidate_id",
      "source_path",
      "source_sha256",
      "body_sha256",
      "approved_title",
      "canonical_url",
      "feed_url",
      "published_at",
      "rss_checked_at",
    ]) {
      expect(writer).toContain(`current_receipt.${field} = p_${field}`);
      expect(writer).toContain(`current_receipt.${field}`);
    }
    expect(writer.match(/insert into public\.marketing_tutorial_publication_receipts/gi))
      .toHaveLength(1);
    expect(writer).not.toMatch(
      /(?:update|delete from|truncate) public\.marketing_tutorial_publication_receipts/i,
    );
    expect(writer).toContain("current_receipt.recorded_at");
  });
});
