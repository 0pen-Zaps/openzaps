import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260801180000_marketing_discord_delivery_receipts.sql",
  ),
  "utf8",
);

describe("Discord durable delivery receipt migration", () => {
  it("requires new Discord completions to bind the canonical URL to the message id", () => {
    expect(migration).toContain(
      "'^https://discord[.]com/channels/[0-9]{1,30}/[0-9]{1,30}/[0-9]{1,30}$'",
    );
    expect(migration).toMatch(
      /pg_catalog\.split_part\(p_provider_url, '\/', 7\) =\s+p_provider_message_id/u,
    );
    expect(migration).toContain(
      "if current_row.status = 'claimed'\n    and p_channel = 'discord'",
    );
    expect(migration).toContain(
      "return query select 'invalid_input'::text, null::text;",
    );
  });

  it("marks only pre-migration URL-less rows as legacy before enforcing version 2", () => {
    expect(migration).toContain(
      "add constraint marketing_delivery_terminal_receipt_check",
    );
    expect(migration).toContain(
      "add column if not exists provider_receipt_version smallint not null default 2",
    );
    expect(migration).toContain("set provider_receipt_version = 1");
    expect(migration).toContain(
      "add constraint marketing_delivery_provider_receipt_version_check",
    );
    expect(migration).toContain("provider_receipt_version = 2");
    expect(migration).toContain(
      "Expected one marketing delivery terminal receipt constraint.",
    );
  });

  it("keeps the completion function service-role-only", () => {
    expect(migration).toContain("security definer\nset search_path = ''");
    expect(migration).toContain(
      ") from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(") to service_role;");
  });
});
