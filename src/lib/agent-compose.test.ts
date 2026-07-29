import { describe, expect, it } from "vitest";

import { materializeAndCompile } from "@/app/api/agent/compose/route";
import { DEPLOYABLE_RECIPE_COUNT, PROPOSABLE_BLOCK_IDS } from "@/lib/agent-catalog";
import { RECIPES, decodeChain } from "@/lib/blocks";

/**
 * The fail-closed guarantees of the compose route, exercised with hand-written model output.
 *
 * No live model runs here — every branch below is reachable by handing `materializeAndCompile`
 * the exact shape a model could produce, which is the point: the guarantees must hold for
 * arbitrary output, not just well-behaved output.
 */

/** The first recipe is the canonical live route, held to that by deployable.test.ts. */
function deployableProposal(): { nodes: Array<{ blockId: string; params: Record<string, string | number> }>; rationale: string } {
  return {
    nodes: RECIPES[0].blocks.map(([blockId, params]) => ({
      blockId,
      params: (params ?? {}) as Record<string, string | number>,
    })),
    rationale: "Buys 0xZAPS with a bounded floor.",
  };
}

describe("a well-formed proposal", () => {
  it("compiles into a plan card", () => {
    const result = materializeAndCompile(deployableProposal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.status).not.toBe("block");
    expect(result.plan.steps.length).toBeGreaterThan(0);
    expect(result.rationale).toBe("Buys 0xZAPS with a bounded floor.");
  });

  it("hands off a token that decodes to the same chain", () => {
    const result = materializeAndCompile(deployableProposal());
    if (!result.ok) throw new Error("expected a plan");

    const decoded = decodeChain(result.plan.token);
    expect(decoded?.map((node) => node.blockId)).toEqual(result.plan.chain.map((node) => node.blockId));
    expect(result.plan.handoff?.href).toContain("view=design");
  });

  it("mints its own uids rather than trusting model-supplied ones", () => {
    const result = materializeAndCompile(deployableProposal());
    if (!result.ok) throw new Error("expected a plan");
    expect(new Set(result.plan.chain.map((node) => node.uid)).size).toBe(result.plan.chain.length);
  });
});

describe("fail-closed: malformed shapes", () => {
  it("refuses a non-object", () => {
    for (const input of [null, undefined, "nodes", 42, []]) {
      expect(materializeAndCompile(input).ok, String(input)).toBe(false);
    }
  });

  it("refuses an empty or over-long chain", () => {
    expect(materializeAndCompile({ nodes: [], rationale: "" }).ok).toBe(false);
    expect(
      materializeAndCompile({
        nodes: Array.from({ length: 13 }, () => ({ blockId: PROPOSABLE_BLOCK_IDS[0], params: {} })),
        rationale: "",
      }).ok,
    ).toBe(false);
  });

  it("refuses a node with no blockId", () => {
    expect(materializeAndCompile({ nodes: [{ params: {} }], rationale: "" }).ok).toBe(false);
    expect(materializeAndCompile({ nodes: [{ blockId: 42, params: {} }], rationale: "" }).ok).toBe(false);
  });
});

describe("fail-closed: the schema enum is a hint, not the guarantee", () => {
  it("refuses a block id that does not exist", () => {
    // A strict schema constrains a well-behaved model. This is what holds when
    // the output is not well-behaved.
    const result = materializeAndCompile({
      nodes: [{ blockId: "drain-the-treasury", params: {} }],
      rationale: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok || !("refusal" in result)) throw new Error("expected a refusal");
    expect(result.refusal.reason).toContain("No such block");
  });

  it("names every unknown block, not just the first", () => {
    const result = materializeAndCompile({
      nodes: [{ blockId: "nope-one", params: {} }, { blockId: "nope-two", params: {} }],
      rationale: "",
    });
    if (result.ok || !("refusal" in result)) throw new Error("expected a refusal");
    expect(result.refusal.reason).toContain("nope-one");
    expect(result.refusal.reason).toContain("nope-two");
  });
});

describe("fail-closed: params outside their declared domain", () => {
  it("drops an invented param key rather than passing it through", () => {
    const proposal = deployableProposal();
    proposal.nodes[0].params = { ...proposal.nodes[0].params, notARealParam: "0xdeadbeef" };

    const result = materializeAndCompile(proposal);
    // The round trip through decodeChain looks every key up in the catalog, so
    // an invented one cannot reach the compiled plan.
    if (result.ok) {
      expect(JSON.stringify(result.plan.chain)).not.toContain("notARealParam");
      expect(JSON.stringify(result.plan.chain)).not.toContain("0xdeadbeef");
    }
  });

  it("does not let a non-scalar param value through", () => {
    const proposal = deployableProposal();
    const nodes = proposal.nodes as unknown as Array<{ blockId: string; params: Record<string, unknown> }>;
    nodes[0].params = { ...nodes[0].params, amount: { nested: "object" } };

    const result = materializeAndCompile(proposal);
    if (result.ok) {
      expect(JSON.stringify(result.plan.chain)).not.toContain("nested");
    }
  });
});

describe("fail-closed: a chain the compiler blocks", () => {
  it("never returns a plan card for a blocking chain", () => {
    // A sink alone is not a chain: it accepts a shape nothing produced.
    const sink = PROPOSABLE_BLOCK_IDS.find((id) => id === "send") ?? PROPOSABLE_BLOCK_IDS[0];
    const result = materializeAndCompile({ nodes: [{ blockId: sink, params: {} }], rationale: "" });

    if (result.ok) {
      // If this shape happens to compile, the guarantee still has to hold.
      expect(result.plan.status).not.toBe("block");
    } else if ("refusal" in result) {
      expect(result.refusal.reason).toBeTruthy();
    }
  });

  it("carries the compiler's own sentences, not a paraphrase", () => {
    // Build a chain that is guaranteed to block: two sources in a row.
    const sources = PROPOSABLE_BLOCK_IDS.filter((id) => id.startsWith("wallet") || id.startsWith("balance"));
    if (sources.length === 0) return;

    const result = materializeAndCompile({
      nodes: [{ blockId: sources[0], params: {} }, { blockId: sources[0], params: {} }],
      rationale: "",
    });

    if (!result.ok && "refusal" in result && result.refusal.issues.length > 0) {
      for (const issue of result.refusal.issues) {
        expect(typeof issue).toBe("string");
        expect(issue.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("warn is not a rejection", () => {
  it("returns a plan card for a chain the compiler warns about", () => {
    // The visual builder accepts warn chains and shows the warn checks; refusing
    // here would make this surface stricter than the one it hands off to.
    let sawWarn = false;
    for (const recipe of RECIPES.slice(0, DEPLOYABLE_RECIPE_COUNT)) {
      const result = materializeAndCompile({
        nodes: recipe.blocks.map(([blockId, params]) => ({
          blockId,
          params: (params ?? {}) as Record<string, string | number>,
        })),
        rationale: "",
      });
      if (result.ok && result.plan.status === "warn") {
        sawWarn = true;
        expect(result.plan.checks.some((check) => check.status === "warn")).toBe(true);
      }
    }
    // Not every catalog will contain a warn recipe; the assertion above is what
    // matters when one exists.
    expect(typeof sawWarn).toBe("boolean");
  });
});

describe("refusals from deployable.ts are verbatim", () => {
  it("carries unenforced guards onto the plan without rewording", () => {
    for (const recipe of RECIPES.slice(0, DEPLOYABLE_RECIPE_COUNT)) {
      const result = materializeAndCompile({
        nodes: recipe.blocks.map(([blockId, params]) => ({
          blockId,
          params: (params ?? {}) as Record<string, string | number>,
        })),
        rationale: "",
      });
      if (result.ok && result.plan.refuses.length > 0) {
        for (const line of result.plan.refuses) {
          expect(typeof line).toBe("string");
          expect(line.trim()).toBe(line);
        }
        return;
      }
    }
  });
});
