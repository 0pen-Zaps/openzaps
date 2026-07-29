import { describe, expect, it } from "vitest";

import { deterministicProposalFor, deterministicRecipeId } from "@/lib/intent-compose";

describe("deterministic intent composition", () => {
  it.each([
    ["buy 0xZAPS with aeWETH", "live-route"],
    ["sell 0xZAPS back to aeWETH", "sell-zaps"],
    ["buy 0xZAPS with USDG", "stitched-route"],
    ["sell 0xZAPS to USDG", "stitched-exit"],
    ["swap USDG to 0xZAPS", "stitched-route"],
    ["swap 0xZAPS to USDG", "stitched-exit"],
    ["buy aeWETH with USDG", "usdg-weth"],
    ["sell aeWETH to USDG", "weth-usdg"],
    ["DCA into 0xZAPS every week", "dca"],
    ["trigger when the price rises", "price-trigger"],
    ["provide liquidity from USDG", "provide-liquidity-usdg"],
    ["withdraw my ozRANGE to aeWETH", "exit-liquidity-weth"],
    ["park USDG in the ozUSDG vault", "vault-park"],
    ["redeem ozUSDG back to USDG", "vault-redeem"],
  ])("maps %s to the reviewed %s recipe", (prompt, recipe) => {
    expect(deterministicRecipeId(prompt.toLowerCase())).toBe(recipe);
  });

  it("refuses to invent a route for an unsupported intent", () => {
    expect(deterministicProposalFor("borrow against an NFT on another chain")).toBeNull();
  });

  it("returns only catalog-shaped nodes", () => {
    const proposal = deterministicProposalFor("buy 0xZAPS with aeWETH");
    expect(proposal?.nodes.length).toBeGreaterThan(0);
    expect(proposal?.nodes.every((node) => typeof node.blockId === "string")).toBe(true);
  });
});
