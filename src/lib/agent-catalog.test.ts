import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL,
  DEPLOYABLE_RECIPE_COUNT,
  PROPOSABLE_BLOCKS,
  PROPOSABLE_BLOCK_IDS,
  PROPOSE_CHAIN_TOOL,
  agentSystemPrompt,
} from "@/lib/agent-catalog";
import { BLOCKS, RECIPES, getBlock } from "@/lib/blocks";

describe("the proposable block set", () => {
  it("names only blocks that exist", () => {
    for (const id of PROPOSABLE_BLOCK_IDS) {
      expect(getBlock(id), id).toBeDefined();
    }
  });

  it("excludes blocked blocks", () => {
    // A blocked block is one the builder itself refuses to deploy, so proposing
    // one could only ever produce a refusal card.
    const blocked = BLOCKS.filter((block) => block.maturity === "blocked").map((block) => block.id);
    for (const id of blocked) {
      expect(PROPOSABLE_BLOCK_IDS, id).not.toContain(id);
    }
    expect(PROPOSABLE_BLOCKS.every((block) => block.maturity !== "blocked")).toBe(true);
  });

  it("is not empty", () => {
    expect(PROPOSABLE_BLOCK_IDS.length).toBeGreaterThan(0);
  });

  it("is generated from the catalog, not a hand-maintained copy", () => {
    // If someone adds a live block and this drifts, the model silently never
    // proposes it — no error, no test failure anywhere else.
    expect(PROPOSABLE_BLOCK_IDS.length).toBe(BLOCKS.filter((b) => b.maturity !== "blocked").length);
  });
});

describe("the propose_chain tool schema", () => {
  it("forces a closed object with both fields required", () => {
    expect(PROPOSE_CHAIN_TOOL.strict).toBe(true);
    expect(PROPOSE_CHAIN_TOOL.input_schema.additionalProperties).toBe(false);
    expect(PROPOSE_CHAIN_TOOL.input_schema.required).toEqual(["nodes", "rationale"]);
  });

  it("constrains blockId to the catalog enum", () => {
    const items = PROPOSE_CHAIN_TOOL.input_schema.properties.nodes.items;
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.blockId.enum).toEqual(PROPOSABLE_BLOCK_IDS);
  });

  it("bounds the chain length", () => {
    const nodes = PROPOSE_CHAIN_TOOL.input_schema.properties.nodes;
    expect(nodes.minItems).toBe(1);
    expect(nodes.maxItems).toBe(12);
  });

  it("has no field anywhere for an address, calldata, or a wei amount", () => {
    // This is the structural half of "the model never produces a transaction":
    // there is nowhere in the schema to put one.
    const json = JSON.stringify(PROPOSE_CHAIN_TOOL).toLowerCase();
    for (const forbidden of ["address", "calldata", "recipient", "wei", "signature", "privatekey", "to\":"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the system prompt", () => {
  const prompt = agentSystemPrompt();

  it("lists every proposable block", () => {
    for (const id of PROPOSABLE_BLOCK_IDS) {
      expect(prompt, id).toContain(id);
    }
  });

  it("cites only recipes from the deployable set", () => {
    // deployable.test.ts holds the first twelve recipes to that claim. Citing
    // past that boundary would teach the model to propose designs the compiler
    // then refuses.
    const deployable = RECIPES.slice(0, DEPLOYABLE_RECIPE_COUNT);
    const beyond = RECIPES.slice(DEPLOYABLE_RECIPE_COUNT);

    const patterns = prompt.slice(prompt.indexOf("DEPLOYABLE PATTERNS"));
    for (const recipe of deployable) {
      expect(patterns, recipe.name).toContain(recipe.name);
    }
    for (const recipe of beyond) {
      expect(patterns, recipe.name).not.toContain(recipe.name);
    }
  });

  it("tells the model it does not decide legality", () => {
    expect(prompt).toContain("You do not decide legality");
    expect(prompt).toContain("never choose addresses");
  });

  it("describes each block's param domains", () => {
    // The model proposes values that survive decodeChain's domain check only if
    // it is told what the domains are.
    const withSelect = PROPOSABLE_BLOCKS.find((block) => block.params.some((p) => p.type === "select"));
    if (withSelect) {
      const param = withSelect.params.find((p) => p.type === "select");
      expect(param && prompt).toContain(`${param?.key}=one of [`);
    }
  });
});

describe("the model id", () => {
  it("defaults to a current model and is overridable", () => {
    expect(AGENT_MODEL).toBeTruthy();
    expect(AGENT_MODEL).toBe(process.env.OPENZAPS_AGENT_MODEL ?? "claude-opus-5");
  });
});
