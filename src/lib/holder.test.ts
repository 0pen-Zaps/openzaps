import { describe, expect, it } from "vitest";

import {
  HOLDER_THRESHOLD,
  OPERATOR_THRESHOLD,
  autoRefreshQuotes,
  canExportReceipts,
  holderTierFor,
  receiptLimitFor,
  savedZapLimitFor,
  tierLabel,
} from "@/lib/holder";

describe("holderTierFor", () => {
  it("maps balances to tiers with exact threshold boundaries", () => {
    expect(holderTierFor(0n)).toBe("none");
    expect(holderTierFor(HOLDER_THRESHOLD - 1n)).toBe("none");
    expect(holderTierFor(HOLDER_THRESHOLD)).toBe("holder");
    expect(holderTierFor(OPERATOR_THRESHOLD - 1n)).toBe("holder");
    expect(holderTierFor(OPERATOR_THRESHOLD)).toBe("operator");
  });

  it("thresholds are 100k and 1M tokens at 18 decimals", () => {
    expect(HOLDER_THRESHOLD).toBe(100_000n * 10n ** 18n);
    expect(OPERATOR_THRESHOLD).toBe(1_000_000n * 10n ** 18n);
  });
});

describe("tier utilities", () => {
  it("scales saved-zap and receipt retention by tier", () => {
    expect(savedZapLimitFor("none")).toBe(20);
    expect(savedZapLimitFor("holder")).toBe(50);
    expect(savedZapLimitFor("operator")).toBe(100);
    expect(receiptLimitFor("none")).toBe(20);
    expect(receiptLimitFor("holder")).toBe(100);
  });

  it("gates export and auto-refresh to holder tiers", () => {
    expect(canExportReceipts("none")).toBe(false);
    expect(canExportReceipts("holder")).toBe(true);
    expect(autoRefreshQuotes("none")).toBe(false);
    expect(autoRefreshQuotes("operator")).toBe(true);
  });

  it("labels holder tiers and leaves none unlabeled", () => {
    expect(tierLabel("none")).toBe("");
    expect(tierLabel("holder")).toBe("0xZAPS Holder");
    expect(tierLabel("operator")).toBe("0xZAPS Operator");
  });
});
