import { RECIPES, type ParamValue, type ZapRecipe } from "@/lib/blocks";

export type DeterministicProposal = {
  nodes: Array<{ blockId: string; params: Record<string, ParamValue> }>;
  rationale: string;
};

/**
 * Resolve plain language to one of the catalog's reviewed blueprints.
 *
 * This is deliberately a small classifier, not a second agent. It is only used
 * when the hosted model is absent, and it can only return a recipe that already
 * exists in `RECIPES`. The compose route still round-trips the result through
 * the untrusted share-link decoder and compiler before returning a handoff.
 */
export function deterministicProposalFor(prompt: string): DeterministicProposal | null {
  const text = prompt.trim().toLowerCase();
  if (!text) return null;

  const recipeId = deterministicRecipeId(text);
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  return recipe ? proposalFromRecipe(recipe) : null;
}

export function deterministicRecipeId(text: string): string | null {
  if (/\bozusdg\b/.test(text) && /\b(redeem|unwrap|withdraw|exit|back to usdg)\b/.test(text)) {
    return "vault-redeem";
  }
  if (/\b(recurring|repeat|dca|daily|weekly|monthly|every (?:day|week|month))\b/.test(text)) {
    return "dca";
  }
  if (/\b(trigger|when (?:the )?price|rises?|falls?|up \d+|down \d+)\b/.test(text)) {
    return "price-trigger";
  }
  if (/\b(liquidity|lp|ozrange)\b/.test(text) && /\b(exit|withdraw|remove|redeem)\b/.test(text)) {
    return /\b(weth|eth|aeweth)\b/.test(text) ? "exit-liquidity-weth" : "exit-liquidity";
  }
  if (/\b(liquidity|lp|provide)\b/.test(text)) {
    return /\busdg\b/.test(text) ? "provide-liquidity-usdg" : "provide-liquidity";
  }
  if (/\bozusdg\b/.test(text) || (/\busdg\b/.test(text) && /\b(deposit|park|vault|wrap)\b/.test(text))) {
    return "vault-park";
  }
  if (/\b0xzaps\b/.test(text) && /\busdg\b/.test(text)) {
    if (/\b(sell|exit|cash out|zap out)\b/.test(text) || /\b(?:from|with) 0xzaps\b/.test(text)) {
      return "stitched-exit";
    }
    if (/\b(buy|enter|zap in)\b/.test(text) || /\b(?:from|with) usdg\b/.test(text)) {
      return "stitched-route";
    }
    return text.indexOf("0xzaps") < text.indexOf("usdg") ? "stitched-exit" : "stitched-route";
  }
  if (/\busdg\b/.test(text) && /\b(weth|eth|aeweth)\b/.test(text)) {
    if (/\b(sell|exit|cash out|zap out)\b/.test(text) || /\b(?:from|with) (?:weth|eth|aeweth)\b/.test(text)) {
      return "weth-usdg";
    }
    if (/\b(buy|enter|zap in)\b/.test(text) || /\b(?:from|with) usdg\b/.test(text)) {
      return "usdg-weth";
    }
    return text.indexOf("usdg") < Math.max(text.indexOf("weth"), text.indexOf("eth")) ? "usdg-weth" : "weth-usdg";
  }
  if (/\b(sell|exit|cash out|zap out)\b/.test(text) && /\b(zaps|0xzaps)\b/.test(text)) {
    return "sell-zaps";
  }
  if (/\b(buy|swap|zap|0xzaps|zaps)\b/.test(text)) return "live-route";
  return null;
}

function proposalFromRecipe(recipe: ZapRecipe): DeterministicProposal {
  return {
    nodes: recipe.blocks.map(([blockId, params]) => ({ blockId, params: { ...(params ?? {}) } })),
    rationale: `Matched the reviewed “${recipe.name}” catalog blueprint without using a hosted model.`,
  };
}
