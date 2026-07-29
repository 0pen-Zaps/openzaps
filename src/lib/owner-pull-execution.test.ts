import { describe, expect, it } from "vitest";

import {
  exactPermit2ApprovalPlan,
  oneShotFundingMode,
} from "@/lib/owner-pull-execution";

describe("oneShotFundingMode", () => {
  it("keeps fully funded v1.1 and v1.2 capsules on the prefunded path", () => {
    expect(oneShotFundingMode("v1.1", false, 100n, 100n)).toBe("prefunded");
    expect(oneShotFundingMode("v1.2", false, 101n, 100n)).toBe("prefunded");
  });

  it("offers owner-pull only to an empty, active v1.2 capsule", () => {
    expect(oneShotFundingMode("v1.2", false, 0n, 100n)).toBe("owner-pull");
    expect(oneShotFundingMode("v1.1", false, 0n, 100n)).toBe("needs-funding");
  });

  it("rejects partial prefunding and a permanently halted policy", () => {
    expect(() => oneShotFundingMode("v1.2", false, 1n, 100n)).toThrow(/partial/);
    expect(() => oneShotFundingMode("v1.2", true, 0n, 100n)).toThrow(/halted/);
  });
});

describe("exactPermit2ApprovalPlan", () => {
  it("does nothing for the exact finite allowance", () => {
    expect(exactPermit2ApprovalPlan(100n, 100n)).toEqual([]);
  });

  it("approves the exact amount from zero", () => {
    expect(exactPermit2ApprovalPlan(0n, 100n)).toEqual([100n]);
  });

  it("resets every non-zero mismatch before the exact approval", () => {
    expect(exactPermit2ApprovalPlan(1n, 100n)).toEqual([0n, 100n]);
    expect(exactPermit2ApprovalPlan((1n << 256n) - 1n, 100n)).toEqual([0n, 100n]);
  });
});
