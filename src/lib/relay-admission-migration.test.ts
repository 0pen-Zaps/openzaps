import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260728230000_bounded_relay_admission.sql", import.meta.url),
  "utf8",
);

describe("bounded relay admission migration", () => {
  it("serializes exact open-row admission and installs every intended cap", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("current_total >= 1000000");
    expect(migration).toContain("current_open >= 50000");
    expect(migration).toContain("owner_open >= 500");
    expect(migration).toContain("zap_open >= 128");
    expect(migration).toMatch(
      /create trigger zap_intent_admission_caps\s+before insert on public\.zap_intents/i,
    );
    expect(migration).toMatch(
      /create trigger zap_intent_admission_state_maintenance\s+after update of status on public\.zap_intents/i,
    );
  });

  it("keeps signed artifacts non-deletable/non-truncatable and service updates status-only", () => {
    expect(migration).toMatch(
      /create trigger zap_intent_reject_delete\s+before delete on public\.zap_intents/i,
    );
    expect(migration).toMatch(
      /create trigger zap_intent_reject_truncate\s+before truncate on public\.zap_intents/i,
    );
    expect(migration).toMatch(
      /grant update \(status\) on table public\.zap_intents to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:[^;]*,\s*)?delete(?:\s*,[^;]*)?\s+on table public\.zap_intents/i,
    );
  });

  it("keeps execution receipts insert-only and rejects every destructive mutation", () => {
    expect(migration).toMatch(
      /grant select, insert on table public\.execution_receipts to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:[^;]*,\s*)?update(?:\s*,[^;]*)?\s+on table public\.execution_receipts/i,
    );
    expect(migration).toMatch(
      /create trigger execution_receipt_reject_mutation\s+before update or delete or truncate on public\.execution_receipts/i,
    );
  });
});
