import { describe, expect, it } from "vitest";
import { parseEther } from "viem";

import { builderQuoteEconomics } from "@/lib/build-quote";

const GROSS = parseEther("100");

describe("builderQuoteEconomics", () => {
  it("keeps a one-shot quote fee-free and applies only its slippage floor", () => {
    expect(builderQuoteEconomics(GROSS, 500, null)).toEqual({
      grossOut: GROSS,
      recipientOut: GROSS,
      minimumOut: parseEther("95"),
      automationFee: 0n,
    });
  });

  it("shows a trigger's absolute floor after slippage and the 1% output fee", () => {
    expect(builderQuoteEconomics(GROSS, 500, "trigger")).toEqual({
      grossOut: GROSS,
      recipientOut: parseEther("99"),
      minimumOut: parseEther("94.05"),
      automationFee: parseEther("1"),
    });
  });

  it("shows the stricter v3.1 relative floor checked against post-fee recipient output", () => {
    expect(builderQuoteEconomics(GROSS, 500, "recurring")).toEqual({
      grossOut: GROSS,
      recipientOut: parseEther("99"),
      minimumOut: parseEther("95"),
      automationFee: parseEther("1"),
    });
  });
});
