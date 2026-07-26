import { describe, expect, it } from "vitest";

import { makeNode, type ChainNode } from "@/lib/blocks";
import {
  DEFAULT_EXECUTION_POLICY,
  maxFeePerGasWei,
  readExecutionPolicyParams,
  resolveExecutionPolicy,
  writeExecutionPolicyParams,
} from "@/lib/execution-policy";

function chain(...entries: Array<[string, Record<string, string | number>?]>): ChainNode[] {
  return entries.map(([id, params], index) => makeNode(id, `n${index}`, params));
}

describe("resolveExecutionPolicy", () => {
  it("uses the live signing defaults when no explicit block is placed", () => {
    expect(resolveExecutionPolicy(chain(["wallet-balance"]))).toEqual({
      ok: true,
      policy: DEFAULT_EXECUTION_POLICY,
    });
  });

  it("intersects repeated caps at the tightest value and makes owner-only win", () => {
    const result = resolveExecutionPolicy(
      chain(
        ["guard-gas-limit", { maxGas: 2_500_000 }],
        ["guard-gas-limit", { maxGas: 1_500_000 }],
        ["guard-gas-price", { maxFeeGwei: 8 }],
        ["guard-gas-price", { maxFeeGwei: 3 }],
        ["guard-executor", { access: "Anyone" }],
        ["guard-executor", { access: "Owner only" }],
      ),
    );
    expect(result).toEqual({
      ok: true,
      policy: { maxGas: 1_500_000, maxFeePerGasGwei: 3, executorAccess: "owner-only" },
    });
    if (result.ok) expect(maxFeePerGasWei(result.policy)).toBe(3_000_000_000n);
  });

  it("fails closed on values outside the signing domain", () => {
    const result = resolveExecutionPolicy(
      chain(
        ["guard-gas-limit", { maxGas: 99_999 }],
        ["guard-gas-price", { maxFeeGwei: 11 }],
        ["guard-executor", { access: "Some bot" }],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid policy controls");
    expect(result.reasons).toHaveLength(3);
  });
});

describe("execution-policy handoff", () => {
  it("round-trips an explicit policy through URL parameters", () => {
    const params = new URLSearchParams();
    const policy = { maxGas: 1_750_000, maxFeePerGasGwei: 4, executorAccess: "owner-only" } as const;
    writeExecutionPolicyParams(params, policy);
    expect(Object.fromEntries(params)).toEqual({
      maxGas: "1750000",
      maxFeeGwei: "4",
      executor: "owner",
    });
    expect(readExecutionPolicyParams(params)).toEqual(policy);
  });

  it("keeps old links compatible and rejects malformed overrides", () => {
    expect(readExecutionPolicyParams(new URLSearchParams())).toEqual(DEFAULT_EXECUTION_POLICY);
    expect(readExecutionPolicyParams(new URLSearchParams("maxGas=0"))).toBeNull();
    expect(readExecutionPolicyParams(new URLSearchParams("maxFeeGwei=1.5"))).toBeNull();
    expect(readExecutionPolicyParams(new URLSearchParams("executor=attacker"))).toBeNull();
  });
});
