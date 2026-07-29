import { decodeAbiParameters, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  buildLivePolicy,
  decodeIntermediateMinimum,
  decodeLivePolicyPlan,
  encodeLivePolicyPlan,
  resolveLivePolicyPlan,
  resolveOnchainLivePolicy,
} from "@/lib/live-policy";
import { buildRoutePolicy } from "@/lib/openzap";

const OWNER = getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2");

const TWO_STEP = {
  version: 1 as const,
  steps: [
    { routeId: "robinhood-v4-weth-usdg", amountIn: "0.05" },
    { routeId: "robinhood-v4-route-usdg-zaps", amountIn: "20" },
  ],
};

describe("live policy handoff", () => {
  it("encodes exact order deterministically and canonicalizes decimals", () => {
    const token = encodeLivePolicyPlan([
      { routeId: "robinhood-v4-weth-usdg", amountIn: "00.0500" },
      { routeId: "robinhood-v4-route-usdg-zaps", amountIn: "020.000" },
    ]);
    expect(token).toBe(
      "v1|robinhood-v4-weth-usdg=0.05|robinhood-v4-route-usdg-zaps=20",
    );
    expect(decodeLivePolicyPlan(token)).toEqual(TWO_STEP);
  });

  it("rejects malformed, zero, oversized, and non-canonical tokens", () => {
    expect(decodeLivePolicyPlan("")).toBeNull();
    expect(decodeLivePolicyPlan("v2|robinhood-v4-weth-usdg=0.05")).toBeNull();
    expect(decodeLivePolicyPlan("v1|robinhood-v4-weth-usdg=0")).toBeNull();
    expect(decodeLivePolicyPlan("v1|robinhood-v4-weth-usdg=00.050")).toBeNull();
    expect(
      decodeLivePolicyPlan(
        `v1|${Array.from(
          { length: 17 },
          () => "robinhood-v4-weth-usdg=0.05",
        ).join("|")}`,
      ),
    ).toBeNull();
  });
});

describe("v1.1 ordered policy compilation", () => {
  it("keeps the established single-route policy byte-for-byte", () => {
    const resolved = resolveLivePolicyPlan({
      version: 1,
      steps: [{ routeId: "robinhood-v4-weth-zaps", amountIn: "0.05" }],
    });
    expect(buildLivePolicy(OWNER, resolved)).toEqual(
      buildRoutePolicy(OWNER, resolved.inputRoute, resolved.steps[0].amountIn),
    );
  });

  it("freezes both amounts and binds the intermediate minimum to step 2", () => {
    const resolved = resolveLivePolicyPlan(TWO_STEP);
    const policy = buildLivePolicy(OWNER, resolved);
    expect(policy.steps).toHaveLength(2);
    expect(policy.steps[0]).toMatchObject({
      adapter: resolved.steps[0].route.adapter,
      tokenIn: resolved.steps[0].route.tokenIn.address,
      spender: resolved.steps[0].route.adapter,
      amountIn: 50_000_000_000_000_000n,
    });
    expect(decodeIntermediateMinimum(policy.steps[0].data)).toBe(20_000_000n);
    expect(decodeAbiParameters([{ type: "uint256" }], policy.steps[0].data)[0]).toBe(
      policy.steps[1].amountIn,
    );
    expect(policy.steps[1].data).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(policy.trackedAssets).toEqual(resolved.trackedAssets);
    expect(resolved.outputRoute.tokenOut.symbol).toBe("0xZAPS");
  });

  it("round-trips the exact canonical policy from onchain fields", () => {
    const resolved = resolveLivePolicyPlan(TWO_STEP);
    const policy = buildLivePolicy(OWNER, resolved);
    const read = resolveOnchainLivePolicy(policy);
    expect(read?.plan).toEqual(TWO_STEP);
    expect(read?.steps.map((step) => step.route.id)).toEqual(
      TWO_STEP.steps.map((step) => step.routeId),
    );
  });

  it("rejects disconnected steps instead of inventing an intermediate conversion", () => {
    expect(() =>
      resolveLivePolicyPlan({
        version: 1,
        steps: [
          { routeId: "robinhood-v4-weth-usdg", amountIn: "0.05" },
          { routeId: "robinhood-v4-weth-zaps", amountIn: "0.01" },
        ],
      }),
    ).toThrow("outputs USDG, but step 2 spends aeWETH");
  });

  it("rejects an intermediate adapter that cannot bind the next fixed amount", () => {
    expect(() =>
      resolveLivePolicyPlan({
        version: 1,
        steps: [
          { routeId: "robinhood-v4-weth-zaps", amountIn: "0.05" },
          { routeId: "robinhood-v4-route-zaps-usdg", amountIn: "100" },
        ],
      }),
    ).toThrow("cannot bind the next step's exact required amount");
  });

  it("rejects a final asset spent earlier in the same balance-delta window", () => {
    expect(() =>
      resolveLivePolicyPlan({
        version: 1,
        steps: [
          { routeId: "robinhood-v4-weth-usdg", amountIn: "0.05" },
          { routeId: "robinhood-v4-usdg-weth", amountIn: "20" },
        ],
      }),
    ).toThrow("both spent by an earlier step and used as final settlement");
  });

  it("rejects tampered intermediate calldata even when its ABI shape is valid", () => {
    const resolved = resolveLivePolicyPlan(TWO_STEP);
    const policy = buildLivePolicy(OWNER, resolved);
    const tampered = {
      ...policy,
      steps: [
        {
          ...policy.steps[0],
          data: "0x0000000000000000000000000000000000000000000000000000000000000001" as const,
        },
        policy.steps[1],
      ],
    };
    expect(resolveOnchainLivePolicy(tampered)).toBeNull();
  });
});
