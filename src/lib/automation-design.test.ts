import { describe, expect, it } from "vitest";

import { automationHandoff, reduceChainToAutomation } from "@/lib/automation-design";
import { makeNode, RECIPES, type ChainNode } from "@/lib/blocks";
import { readAutomationHandoff } from "@/lib/automate";

function chain(...entries: Array<[string, Record<string, string | number>?]>): ChainNode[] {
  return entries.map(([id, params], index) => makeNode(id, `n${index}`, params));
}

describe("reduceChainToAutomation", () => {
  it("round-trips every automatable blueprint through the Automate query parser", () => {
    const mapped = RECIPES.flatMap((recipe) => {
      const result = reduceChainToAutomation(
        recipe.blocks.map(([blockId, params], index) => makeNode(blockId, `${recipe.id}-${index}`, params)),
      );
      if (!result.deployable) return [];
      const url = new URL(automationHandoff(result), "https://0xzaps.com");
      return [{ id: recipe.id, result, imported: readAutomationHandoff(url.searchParams) }];
    });

    expect(mapped.map(({ id }) => id)).toEqual(["dca", "price-trigger"]);
    for (const entry of mapped) {
      expect(entry.imported, entry.id).not.toBeNull();
      expect(entry.imported?.mode, entry.id).toBe(entry.result.mode);
      expect(entry.imported?.routeId, entry.id).toBe(entry.result.routeId);
      expect(entry.imported?.amount, entry.id).toBe(entry.result.amountIn);
      expect(entry.imported?.slippageBps, entry.id).toBe(entry.result.slippageBps);
      expect(entry.imported?.validDays, entry.id).toBe(entry.result.validDays);
    }
  });

  it("maps a recurring source into a bounded recurring automation", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.001", cadence: "weekly", runs: 12 }],
        ["guard-slippage", { bps: 100 }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["send", { recipient: "owner wallet" }],
      ),
    );

    expect(result).toEqual({
      deployable: true,
      mode: "recurring",
      routeId: "robinhood-v4-weth-zaps",
      amountIn: "0.001",
      slippageBps: 100,
      intervalId: "weekly",
      maxRuns: 12,
      validDays: null,
    });
    if (!result.deployable) throw new Error("expected automation mapping");
    const params = new URL(automationHandoff(result), "https://0xzaps.com").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      view: "automate",
      src: "build",
      mode: "recurring",
      route: "robinhood-v4-weth-zaps",
      amount: "0.001",
      bps: "100",
      interval: "weekly",
      runs: "12",
    });
  });

  it("maps a one-sided price condition into the matching trigger preset", () => {
    const result = reduceChainToAutomation(
      chain(
        ["wallet-balance", { asset: "0xZAPS", amount: "100000" }],
        ["guard-slippage", { bps: 200 }],
        ["price-trigger", { condition: "down25" }],
        ["guard-window", { expiry: "30 days" }],
        ["swap", { into: "WETH", venue: "Uniswap v4" }],
        ["send", { recipient: "owner wallet" }],
      ),
    );

    expect(result).toEqual({
      deployable: true,
      mode: "trigger",
      routeId: "robinhood-v4-zaps-weth",
      amountIn: "100000",
      slippageBps: 200,
      thresholdId: "down25",
      validDays: 30,
    });
  });

  it("refuses a route for which the automation stack has no price source", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.01", cadence: "daily", runs: 5 }],
        ["guard-slippage", { bps: 100 }],
        ["swap", { into: "USDG", venue: "Uniswap v4" }],
        ["send", { recipient: "owner wallet" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons.join(" ")).toContain("pinned aeWETH <-> 0xZAPS pool");
  });

  it("does not pretend cadence and price trigger can share one standing intent", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.01", cadence: "daily", runs: 5 }],
        ["price-trigger", { condition: "up10" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("cannot combine");
  });

  it("rejects guards the selected live automation intent cannot enforce", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.01", cadence: "daily", runs: 5 }],
        ["guard-window", { expiry: "30 days" }],
        ["guard-oracle", { band: 10 }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("cannot enforce");
    expect(result.reasons[0]).toContain("Price band");
  });

  it("rejects a recurring expiry that ends before all scheduled runs", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.01", cadence: "weekly", runs: 10 }],
        ["guard-window", { expiry: "30 days" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("ends before all 10 scheduled runs");
  });

  it("rejects a spend cap below the exact per-run amount times run count", () => {
    const result = reduceChainToAutomation(
      chain(
        ["recurring-stream", { asset: "WETH", amount: "0.01", cadence: "daily", runs: 5 }],
        ["guard-spend", { cap: 0.049 }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("below the 5-run funding total");
  });

  it("rejects multiple trigger expiry windows instead of silently choosing one", () => {
    const result = reduceChainToAutomation(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.01" }],
        ["price-trigger", { condition: "up10" }],
        ["guard-window", { expiry: "7 days" }],
        ["guard-window", { expiry: "30 days" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("exactly one expiry window");
  });

  it("requires a bounded trigger window and supported move", () => {
    const result = reduceChainToAutomation(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.01" }],
        ["price-trigger", { condition: "up3" }],
        ["guard-window", { expiry: "never" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) throw new Error("expected refusal");
    expect(result.reasons[0]).toContain("5%, 10%, or 25%");
  });
});
