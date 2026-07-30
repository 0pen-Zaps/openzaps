import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";

import { expectedCloneRuntime } from "@/lib/openzap";
import {
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
} from "@/lib/robinhood";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260728230000_bounded_relay_admission.sql", import.meta.url),
  "utf8",
);
const receiptProvenanceMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260729095505_harden_verified_receipt_provenance.sql",
    import.meta.url,
  ),
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

describe("verified receipt provenance hardening migration", () => {
  it("stops on malformed historical evidence before replacing the constraint", () => {
    expect(receiptProvenanceMigration).toMatch(
      /if exists \(\s*select 1\s*from public\.execution_receipts\s*where provenance_verified/is,
    );
    expect(receiptProvenanceMigration).toContain(
      "execution_receipts contains malformed verified provenance; reconcile before migration",
    );
  });

  it("makes every verified provenance field explicitly non-null", () => {
    for (const column of [
      "factory",
      "implementation",
      "implementation_code_hash",
      "capsule_runtime_hash",
      "creation_tx_hash",
      "creation_block",
    ]) {
      expect(receiptProvenanceMigration).toMatch(
        new RegExp(`${column} is not null`, "i"),
      );
    }
    expect(receiptProvenanceMigration).toMatch(
      /add constraint execution_receipts_provenance_check check/i,
    );
  });

  it("binds every intent kind to its exact factory, implementation, and runtime hashes", () => {
    for (const expected of [
      [
        "intent_kind in ('recurring', 'trigger')",
        OPENZAP_V3_CONTRACTS.factory.toLowerCase(),
        OPENZAP_V3_CONTRACTS.implementation.toLowerCase(),
        "0x99c49515bd0a7038c216a0d710676c4c63bb7dd09108de5fddca885542057149",
        keccak256(expectedCloneRuntime(OPENZAP_V3_CONTRACTS.implementation)),
      ],
      [
        "intent_kind = 'recurring-relative'",
        OPENZAP_V3_1_CONTRACTS.factory.toLowerCase(),
        OPENZAP_V3_1_CONTRACTS.implementation.toLowerCase(),
        "0xe18008b64e593526441c989e3ade3b12c056a4dfe9b7e34e59a8f124f4be979c",
        keccak256(expectedCloneRuntime(OPENZAP_V3_1_CONTRACTS.implementation)),
      ],
      [
        "intent_kind = 'recurring-stack'",
        OPENZAP_V3_2_CONTRACTS.factory.toLowerCase(),
        OPENZAP_V3_2_CONTRACTS.implementation.toLowerCase(),
        "0xe271b762131d9e198769ed44124fa52eef4051e00da517716136dae5bfcef321",
        keccak256(expectedCloneRuntime(OPENZAP_V3_2_CONTRACTS.implementation)),
      ],
    ]) {
      for (const fragment of expected) {
        expect(receiptProvenanceMigration).toContain(fragment);
      }
    }
  });
});
