import { describe, expect, it } from "vitest";

import { buildPolicyDraft, simulatePolicy } from "@/lib/policy";

describe("structural policy review", () => {
  it("does not substitute fixed token prices or synthetic gas for chain evidence", () => {
    const result = simulatePolicy(
      buildPolicyDraft({
        amount: "1",
        maxSpend: "1",
        tokenIn: "WETH",
        tokenOut: "0xZAPS",
      }),
    );

    expect(result.mode).toBe("structural-only");
    expect(result.status).toBe("warn");
    expect(result.estimatedOut).toContain("block-pinned");
    expect(result.relayerFee).toContain("exact compiled policy");
    expect(result.gasEstimate).toContain("eth_call");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Chain evidence required",
        status: "warn",
      }),
    );
  });
});
