import { describe, expect, it } from "vitest";

import {
  automationIntentKey,
  automationRecordMatchesIntentKey,
  automationStorageKey,
  parseAutomationIntent,
  parseAutomationRecords,
  type AutomationRecord,
} from "@/lib/automation-records";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const OUT = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07" as const;
const EXECUTOR = "0x0000000000000000000000000000000000000000" as const;
const HASH = "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270" as const;
const SIG = `0x${"ab".repeat(65)}`;

function relativeIntent(): string {
  return JSON.stringify({
    kind: "recurring-relative",
    intent: {
      zap: ZAP,
      chainId: "4663",
      seriesId: "123456789012345678901234567890",
      validAfter: "1700000000",
      deadline: "1709999999",
      interval: "86400",
      maxRuns: "10",
      recipient: OWNER,
      executor: EXECUTOR,
      maxGas: "2000000",
      maxFeePerGas: "10000000000",
      policyHash: HASH,
      outAsset: OUT,
      priceSource: "0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F",
      maxSlippageBps: "500",
    },
    signature: SIG,
  });
}

function record(overrides: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    address: ZAP,
    routeId: "robinhood-v4-weth-zaps",
    mode: "recurring",
    amountPerRun: "1000000000000000",
    createdAt: "2026-07-25T00:00:00.000Z",
    policyHash: HASH,
    plannedRuns: 10,
    intentFile: relativeIntent(),
    ...overrides,
  };
}

describe("parseAutomationIntent", () => {
  it("preserves uint256 precision and normalizes recurring-relative to recurring management", () => {
    const parsed = parseAutomationIntent(relativeIntent());
    expect(parsed?.kind).toBe("recurring-relative");
    expect(parsed?.mode).toBe("recurring");
    expect(parsed?.authorizationId).toBe(123456789012345678901234567890n);
    expect(parsed?.maxRuns).toBe(10);
    expect(parsed?.interval).toBe(86_400n);
  });

  it("rejects a schema-invalid artifact instead of guessing its authority", () => {
    const malformed = JSON.parse(relativeIntent()) as { intent: Record<string, unknown> };
    delete malformed.intent.seriesId;
    expect(parseAutomationIntent(JSON.stringify(malformed))).toBeNull();
  });
});

describe("parseAutomationRecords", () => {
  it("loads a valid row and keeps relay cancellation metadata", () => {
    const parsed = parseAutomationRecords(JSON.stringify([
      record({
        relayId: "0198a941-58d8-7000-8000-000000000001",
        revokedAt: "2026-07-26T00:00:00.000Z",
        revocationTx: `0x${"12".repeat(32)}`,
      }),
    ]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].address).toBe(ZAP);
    expect(parsed[0].relayId).toBe("0198a941-58d8-7000-8000-000000000001");
    expect(parsed[0].revocationTx).toBe(`0x${"12".repeat(32)}`);
  });

  it("drops a record whose signed artifact targets another capsule", () => {
    expect(parseAutomationRecords(JSON.stringify([
      record({ address: "0x1111111111111111111111111111111111111111" }),
    ]))).toEqual([]);
  });

  it("drops a record whose display policy hash disagrees with its signed artifact", () => {
    expect(parseAutomationRecords(JSON.stringify([
      record({ policyHash: `0x${"cd".repeat(32)}` }),
    ]))).toEqual([]);
  });

  it("deduplicates by capsule address with the newest stored row winning", () => {
    const parsed = parseAutomationRecords(JSON.stringify([
      record({ terms: "old" }),
      record({ terms: "new" }),
    ]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].terms).toBe("new");
  });
});

describe("automationRecordMatchesIntentKey", () => {
  it("matches the full capsule and series identity, not the capsule alone", () => {
    const parsed = parseAutomationIntent(relativeIntent());
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const key = automationIntentKey(parsed);
    expect(automationRecordMatchesIntentKey(record(), key)).toBe(true);

    const other = JSON.parse(relativeIntent()) as { intent: { seriesId: string } };
    other.intent.seriesId = "987654321";
    expect(automationRecordMatchesIntentKey(record({ intentFile: JSON.stringify(other) }), key)).toBe(false);
  });
});

describe("automationStorageKey", () => {
  it("scopes records to the normalized wallet address", () => {
    expect(automationStorageKey(OWNER)).toBe(`openzap:v3:automations:${OWNER.toLowerCase()}`);
  });
});
