import { describe, expect, it } from "vitest";

import { compileChain, decodeChain, makeNode, RECIPES, type ChainNode } from "@/lib/blocks";
import { planFromCompiled, transcriptId } from "@/lib/transcript";

function chainFromRecipe(index: number): ChainNode[] {
  const recipe = RECIPES[index];
  return recipe.blocks.map(([blockId, params], i) => makeNode(blockId, `${recipe.id}-${i}`, params));
}

describe("planFromCompiled", () => {
  it("carries the compiler's verdict without reinterpreting it", () => {
    const chain = chainFromRecipe(0);
    const compiled = compileChain(chain);
    const plan = planFromCompiled(chain, compiled);

    expect(plan.status).toBe(compiled.status);
    expect(plan.hash).toBe(compiled.hash);
    expect(plan.gas).toBe(compiled.gas);
    expect(plan.guardScore).toBe(compiled.guardScore);
    expect(plan.steps).toEqual(compiled.steps);
    expect(plan.checks).toEqual(compiled.checks);
  });

  it("emits a token that decodes back to the same chain", () => {
    // The plan card hands off to ?view=design&d=<token>; if that round trip
    // does not hold, the handoff silently opens a different design.
    const chain = chainFromRecipe(0);
    const plan = planFromCompiled(chain, compileChain(chain));
    const decoded = decodeChain(plan.token);

    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(chain.length);
    expect(decoded?.map((node) => node.blockId)).toEqual(chain.map((node) => node.blockId));
  });

  it("defaults refuses and handoff to empty rather than undefined", () => {
    const chain = chainFromRecipe(0);
    const plan = planFromCompiled(chain, compileChain(chain));

    expect(plan.refuses).toEqual([]);
    expect(plan.handoff).toBeNull();
  });

  it("copies refuses verbatim", () => {
    const chain = chainFromRecipe(0);
    const refuses = ["Surplus from step 1 stays in the capsule.", "The gas cap is not bound onchain."];
    const plan = planFromCompiled(chain, compileChain(chain), { refuses });

    expect(plan.refuses).toEqual(refuses);
  });

  it("does not alias its inputs", () => {
    // A plan is rendered; a chain is edited. Sharing the array between them
    // means editing the canvas silently rewrites the card that justified it.
    const chain = chainFromRecipe(0);
    const refuses = ["one"];
    const plan = planFromCompiled(chain, compileChain(chain), { refuses });

    chain.push(makeNode("guard-gas-limit", "extra", { maxGas: 1_500_000 }));
    refuses.push("two");

    expect(plan.chain).toHaveLength(chain.length - 1);
    expect(plan.refuses).toEqual(["one"]);
  });
});

describe("transcriptId", () => {
  it("is stable for a scope and index, with no clock", () => {
    expect(transcriptId("connect", 3)).toBe("connect-3");
    expect(transcriptId("connect", 3)).toBe(transcriptId("connect", 3));
    expect(transcriptId("profile", 3)).not.toBe(transcriptId("connect", 3));
  });
});
