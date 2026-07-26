import { describe, expect, it } from "vitest";
import { agentPlans, landingCards, shareableCards } from "./data";

describe("landing blueprint data", () => {
  it("features the sell route while keeping one design-only example", () => {
    expect(landingCards().map((card) => card.id)).toEqual([
      "live-route",
      "sell-zaps",
      "stitched-route",
      "provide-liquidity",
      "exit-liquidity",
      "lp-autocompound",
    ]);

    expect(landingCards().find((card) => card.id === "sell-zaps")).toMatchObject({
      name: "Zap out of 0xZAPS",
      deployable: true,
      outputLabel: "ERC-20",
    });
    expect(shareableCards().some((card) => card.id === "sell-zaps")).toBe(true);
  });

  it("publishes the sell-side route as a bounded agent plan", () => {
    expect(agentPlans().find((plan) => plan.id === "sell-zaps")).toMatchObject({
      intent: "Zap 1,000,000 0xZAPS out to aeWETH",
      route: "Uniswap v4 0xZAPS → aeWETH",
    });
  });
});
