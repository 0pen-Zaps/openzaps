import { describe, expect, it } from "vitest";
import { exactAllowancePlan } from "./allowance";

describe("exactAllowancePlan", () => {
  it("accepts only the exact first-buy allowance", () => {
    expect(exactAllowancePlan(10n, 10n)).toEqual({
      isExact: true,
      resetBeforeApproval: false,
      approveAfterReset: false,
      hasResidualAllowance: true,
    });
  });

  it("resets both smaller and larger stale allowances before replacing them", () => {
    expect(exactAllowancePlan(4n, 10n)).toMatchObject({
      isExact: false,
      resetBeforeApproval: true,
      approveAfterReset: true,
    });
    expect(exactAllowancePlan(40n, 10n)).toMatchObject({
      isExact: false,
      resetBeforeApproval: true,
      approveAfterReset: true,
    });
  });

  it("approves from zero without a redundant reset", () => {
    expect(exactAllowancePlan(0n, 10n)).toEqual({
      isExact: false,
      resetBeforeApproval: false,
      approveAfterReset: true,
      hasResidualAllowance: false,
    });
  });

  it("marks a cancelled first buy for revocation", () => {
    expect(exactAllowancePlan(10n, 0n)).toEqual({
      isExact: false,
      resetBeforeApproval: true,
      approveAfterReset: false,
      hasResidualAllowance: true,
    });
  });

  it("rejects invalid negative inputs", () => {
    expect(() => exactAllowancePlan(-1n, 0n)).toThrow(RangeError);
    expect(() => exactAllowancePlan(0n, -1n)).toThrow(RangeError);
  });
});
