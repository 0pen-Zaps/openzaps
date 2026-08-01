import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260801041508_marketing_syndication_inbox.sql",
    import.meta.url,
  ),
  "utf8",
);

const sourceTable = migration.slice(
  migration.indexOf("create table public.marketing_syndication_sources"),
  migration.indexOf("create table public.marketing_syndication_items"),
);

const itemTable = migration.slice(
  migration.indexOf("create table public.marketing_syndication_items"),
  migration.indexOf("create index marketing_syndication_items_operator_order"),
);

describe("marketing syndication inbox migration", () => {
  it("keeps every public table behind RLS with no direct Data API grants", () => {
    for (const table of [
      "marketing_syndication_sources",
      "marketing_syndication_items",
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
        new RegExp(
          `grant\\s+(?:select|insert|update|delete|truncate)[^;]*public\\.${table}`,
          "i",
        ),
      );
    }
  });

  it("exposes only service-role invoker RPCs over private definer implementations", () => {
    for (const name of [
      "get_marketing_syndication_source_cursor",
      "discover_marketing_syndication_items",
      "list_marketing_syndication_items",
      "claim_marketing_syndication_draft",
      "attach_marketing_syndication_workflow",
      "fail_marketing_syndication_draft",
      "skip_marketing_syndication_item",
      "sync_marketing_syndication_item",
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

  it("stores only bounded public feed metadata and stable identities", () => {
    expect(sourceTable).toContain("source_key in ('openzaps', 'defitutorials')");
    expect(sourceTable).toContain("initialized_at timestamptz not null");
    expect(sourceTable).toContain("etag text");
    expect(sourceTable).toContain("last_modified text");
    expect(sourceTable).toContain("last_checked_at timestamptz not null");

    expect(itemTable).toContain("source_item_key text not null");
    expect(itemTable).toContain("unique");
    expect(itemTable).toContain("source_item_key ~ '^[0-9a-f]{64}$'");
    expect(itemTable).toContain("canonical_url text not null unique");
    expect(itemTable).toContain(
      "campaign_slug ~ '^[a-z0-9][a-z0-9-]{0,95}$'",
    );
    expect(itemTable).toContain("classification = 'unknown'");
    expect(itemTable).not.toMatch(
      /\b(?:body|email|author|cookie|request_headers?|ip_address|wallet|fingerprint)\s+text\b/i,
    );
  });

  it("enforces first-snapshot baseline and validator-aware 304 semantics", () => {
    expect(migration).toContain("item_count not between 0 and 100");
    expect(migration).toContain("requested_not_modified");
    expect(migration).toContain("item_count <> 0 or p_initialize_as_baseline");
    expect(migration).toContain(
      "not requested_not_modified\n      and item_count = 0",
    );
    expect(migration).toContain("'baseline_required'::text");
    expect(migration).toContain("'already_initialized'::text");
    expect(migration).toContain("'baselined'::text");
    expect(migration).toContain("'discovered'::text");
    expect(migration).toContain("'not_modified'::text");
    expect(migration).toContain(
      "openzaps-marketing-syndication-discovery",
    );
    expect(migration).toContain("last_checked_at = checked_at");
  });

  it("admits exact item objects without bodies or ambient fetch data", () => {
    for (const key of [
      "source_item_key",
      "canonical_url",
      "title",
      "campaign_slug",
      "published_at",
      "classification",
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
    expect(migration).toContain(") <> 6");
    expect(migration).toContain(
      "classification in ('tutorial', 'product_update', 'unknown')",
    );
    expect(migration).toContain(
      "item.published_at is null and item.classification <> 'unknown'",
    );
    expect(migration).not.toMatch(
      /entries\.item\s*\?&\s*array\[[\s\S]*?'(?:body|cookie|email|author)'/i,
    );
  });

  it("keeps classification and state transitions forward-only", () => {
    const guard = migration.slice(
      migration.indexOf(
        "create or replace function private.enforce_marketing_syndication_item_update",
      ),
      migration.indexOf(
        "create or replace function private.reject_marketing_syndication_deletion",
      ),
    );

    expect(guard).toContain("old.classification = 'unknown'");
    expect(guard).toContain(
      "old.state = 'pending' and new.state in ('drafting', 'skipped')",
    );
    expect(guard).toContain(
      "old.state = 'drafting'\n        and new.state in ('awaiting_approval', 'failed')",
    );
    expect(guard).toContain(
      "old.state = 'awaiting_approval'\n        and new.state in ('published', 'failed')",
    );
    expect(guard).not.toMatch(/old\.state = '(?:published|skipped|failed)'/);
    expect(migration).toContain("marketing syndication evidence is append-only");
  });

  it("claims known items atomically and never reclaims unknown or ambiguous starts", () => {
    const claim = migration.slice(
      migration.indexOf(
        "create or replace function private.claim_marketing_syndication_draft",
      ),
      migration.indexOf(
        "create or replace function public.claim_marketing_syndication_draft",
      ),
    );

    expect(claim).toContain("for update");
    expect(claim).toContain(
      "current_item.classification in ('tutorial', 'product_update')",
    );
    expect(claim).toContain(
      "+ 69\n      + char_length(current_item.campaign_slug) <= 200",
    );
    expect(claim).toContain("outcome := 'unknown_classification'");
    expect(claim).toContain("outcome := 'already_claimed'");
    expect(claim).toContain("outcome := 'already_completed'");
    expect(claim).toContain("current_item.workflow_run_id");
    expect(claim).toContain("current_item.campaign_slug");
  });

  it("makes attach, fail, skip, and workflow sync idempotent and terminal", () => {
    expect(migration).toContain("outcome := 'workflow_conflict'");
    expect(migration).toContain("outcome := 'attached'");
    expect(migration).toContain("outcome := 'already_attached'");
    expect(migration).toContain("outcome := 'already_completed'");
    expect(migration).toContain("outcome := 'already_failed'");
    expect(migration).toContain("outcome := 'already_skipped'");
    expect(migration).toContain("outcome := 'already_synced'");
    expect(migration).toContain(
      "p_state not in ('awaiting_approval', 'published', 'failed')",
    );
    expect(migration).toContain(
      "current_item.state = 'awaiting_approval'\n    and p_state in ('published', 'failed')",
    );
    expect(migration).toContain(
      "if current_item.workflow_run_id is null then\n    outcome := 'invalid_transition'",
    );
  });

  it("returns the bare core item id and exact campaign slug to the server", () => {
    expect(migration).toMatch(
      /create or replace function public\.list_marketing_syndication_items\([\s\S]*?returns table \(\s*item_id text,[\s\S]*?campaign_slug text/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.claim_marketing_syndication_draft\(\s*p_item_id text[\s\S]*?item_id text,[\s\S]*?campaign_slug text/i,
    );
    expect(migration).toContain("items.source_item_key");
    expect(migration).toMatch(
      /when 'drafting' then 0[\s\S]*when 'awaiting_approval' then 1[\s\S]*when 'pending' then 2/u,
    );
    expect(migration).toContain("items.source_published_at desc nulls last");
  });
});
