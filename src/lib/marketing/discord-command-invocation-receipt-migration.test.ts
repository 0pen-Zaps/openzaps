import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260802075750_marketing_discord_command_invocation_receipts.sql",
    import.meta.url,
  ),
  "utf8",
);

const table = migration.slice(
  migration.indexOf(
    "create table if not exists private.marketing_discord_command_invocation_receipts",
  ),
  migration.indexOf(
    "alter table private.marketing_discord_command_invocation_receipts",
  ),
);
const writer = migration.slice(
  migration.indexOf(
    "create or replace function private.record_marketing_discord_command_invocation_receipt(",
  ),
  migration.indexOf(
    "revoke all on function private.record_marketing_discord_command_invocation_receipt(",
  ),
);

describe("Discord command invocation receipt migration", () => {
  it("stores only the opaque target, allowlisted command, manifest, and DB time", () => {
    expect(table).toContain(
      "create table if not exists private.marketing_discord_command_invocation_receipts",
    );
    expect(table).toContain("target_binding_hmac text not null");
    expect(table).toContain("command_name text not null");
    expect(table).toContain("manifest_sha256 text not null");
    expect(table).toContain("first_verified_at timestamptz not null");
    expect(table).toContain(
      "primary key (target_binding_hmac, command_name, manifest_sha256)",
    );
    expect(table).toContain("command_name in ('ask', 'openzaps', 'status')");
    expect(table).toContain(
      "default pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp())",
    );
    expect(table).not.toMatch(
      /\b(?:application_id|guild_id|channel_id|interaction_id|user_id|question|response_body|signature|ip_address|user_agent|invocation_count)\b/iu,
    );
  });

  it("has no direct role access and rejects every post-insert mutation", () => {
    expect(migration).toMatch(
      /alter table private\.marketing_discord_command_invocation_receipts\s+enable row level security/iu,
    );
    expect(migration).toMatch(
      /revoke all on table private\.marketing_discord_command_invocation_receipts\s+from public, anon, authenticated, service_role/iu,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate)[^;]*marketing_discord_command_invocation_receipts/iu,
    );
    expect(migration).toMatch(
      /create trigger marketing_discord_command_invocation_receipts_immutable\s+before update or delete or truncate/iu,
    );
  });

  it("inserts once without accepting a client timestamp or mutating a replay", () => {
    expect(writer).toContain("p_target_binding_hmac text");
    expect(writer).toContain("p_command_name text");
    expect(writer).toContain("p_manifest_sha256 text");
    expect(writer).not.toContain("p_first_verified_at");
    expect(writer).toContain(
      "on conflict on constraint marketing_discord_command_invocation_receipts_pkey",
    );
    expect(writer).toContain("outcome := 'recorded'");
    expect(writer).toContain("outcome := 'already_recorded'");
    expect(writer.match(
      /insert into private\.marketing_discord_command_invocation_receipts/giu,
    )).toHaveLength(1);
    expect(writer).not.toMatch(
      /(?:update|delete from|truncate) private\.marketing_discord_command_invocation_receipts/iu,
    );
  });

  it("exposes service-role-only invoker wrappers over private definers", () => {
    for (const name of [
      "record_marketing_discord_command_invocation_receipt",
      "get_marketing_discord_command_invocation_readback",
    ]) {
      expect(migration).toMatch(new RegExp(
        `create or replace function private\\.${name}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        "iu",
      ));
      expect(migration).toMatch(new RegExp(
        `create or replace function public\\.${name}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = ''`,
        "iu",
      ));
      expect(migration).toMatch(new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?\\) from public, anon, authenticated, service_role`,
        "iu",
      ));
      expect(migration).toMatch(new RegExp(
        `grant execute on function public\\.${name}\\([\\s\\S]*?\\) to service_role`,
        "iu",
      ));
    }
  });

  it("reads exactly the three current commands for one binding and manifest", () => {
    expect(migration).toContain("('ask'::text, 1)");
    expect(migration).toContain("('openzaps'::text, 2)");
    expect(migration).toContain("('status'::text, 3)");
    expect(migration).toContain(
      "receipts.target_binding_hmac = p_target_binding_hmac",
    );
    expect(migration).toContain(
      "receipts.manifest_sha256 = p_manifest_sha256",
    );
    expect(migration).toContain("order by desired.command_order");
  });
});
