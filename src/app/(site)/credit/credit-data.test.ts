import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE,
  CURRENT_STATE,
  INVARIANTS,
  PILOT_PARAMETERS,
  PRODUCT_LAYERS,
  RESEARCH_SOURCES,
  ROLLOUT,
} from "./credit-data";

describe("agent credit research documentation", () => {
  it("keeps current infrastructure separate from proposed and blocked work", () => {
    expect(new Set(CURRENT_STATE.map(({ tone }) => tone))).toEqual(
      new Set(["live", "proposed", "blocked"]),
    );
    expect(CURRENT_STATE.find(({ tone }) => tone === "proposed")?.body).toMatch(/not deployed/i);
  });

  it("defines the three products independently", () => {
    expect(PRODUCT_LAYERS.map(({ title }) => title)).toEqual([
      "Agent Access Pools",
      "Agent Credit Vaults",
      "Agent Credit Markets",
    ]);
  });

  it("documents every critical contract boundary", () => {
    expect(ARCHITECTURE.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "AgentIdentityAdapter",
        "AgentCreditAccount",
        "AgentRouter",
        "AgentGateHook",
        "CreditController",
        "USDGLenderVault",
        "RiskOracle",
        "LiquidationEngine",
      ]),
    );
  });

  it("pins the non-recursive, purpose-bound safety rules", () => {
    const text = INVARIANTS.join(" ");
    expect(text).toMatch(/never be sent to an arbitrary receiver/i);
    expect(text).toMatch(/never increase eligible collateral/i);
    expect(text).toMatch(/liquidation.*do not require agent eligibility/i);
  });

  it("makes the pilot intentionally small and the stablecoin decision last", () => {
    expect(PILOT_PARAMETERS).toContainEqual(
      expect.arrayContaining(["Financed collateral factor", "0%"]),
    );
    expect(ROLLOUT.at(-1)?.name).toBe("Stablecoin decision");
  });

  it("uses unique primary-source links", () => {
    const urls = RESEARCH_SOURCES.map(({ url }) => url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
    expect(RESEARCH_SOURCES.length).toBeGreaterThanOrEqual(10);
  });
});
