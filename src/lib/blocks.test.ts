import { describe, expect, it } from "vitest";

import {
  BLOCKS,
  RECIPES,
  canInsert,
  compileChain,
  getBlock,
  makeNode,
  scoreGuardCoverage,
  shapeBefore,
  type ChainNode,
} from "@/lib/blocks";

function chain(...ids: string[]): ChainNode[] {
  return ids.map((id, index) => makeNode(id, `${id}-${index}`));
}

function block(id: string) {
  const found = getBlock(id);
  if (!found) throw new Error(`missing block ${id}`);
  return found;
}

describe("catalog", () => {
  it("gives every block a unique id", () => {
    expect(new Set(BLOCKS.map((entry) => entry.id)).size).toBe(BLOCKS.length);
  });

  it("keeps kinds and ports consistent", () => {
    for (const entry of BLOCKS) {
      if (entry.kind === "source") expect(entry.accepts).toBeNull();
      if (entry.kind === "sink") expect(entry.emits).toBeNull();
      if (entry.kind === "guard") expect([entry.accepts, entry.emits]).toEqual([null, null]);
      if (entry.kind === "action") {
        expect(entry.accepts).not.toBeNull();
        expect(entry.emits).not.toBeNull();
      }
    }
  });
});

describe("shapeBefore", () => {
  it("is null at the head of a chain", () => {
    expect(shapeBefore(chain("wallet-balance", "swap"), 0)).toBeNull();
  });

  it("reports what the previous block emits", () => {
    expect(shapeBefore(chain("wallet-balance", "swap"), 1)).toBe("token");
    expect(shapeBefore(chain("wallet-balance", "add-liquidity", "stake"), 2)).toBe("lp");
  });

  it("passes straight through guards", () => {
    expect(shapeBefore(chain("wallet-balance", "guard-slippage", "guard-window"), 3)).toBe("token");
  });
});

describe("canInsert", () => {
  it("only seats a matching stud", () => {
    const built = chain("wallet-balance");
    expect(canInsert(built, block("swap"), 1)).toBe(true);
    // A gauge stake wants an LP position, not raw tokens.
    expect(canInsert(built, block("stake"), 1)).toBe(false);
  });

  it("refuses a second source and refuses actions before one", () => {
    expect(canInsert(chain("wallet-balance"), block("wallet-balance"), 1)).toBe(false);
    // Above the existing source is still a second source.
    expect(canInsert(chain("wallet-balance", "swap", "send"), block("recurring-stream"), 0)).toBe(false);
    expect(canInsert([], block("swap"), 0)).toBe(false);
    expect(canInsert([], block("wallet-balance"), 0)).toBe(true);
  });

  it("checks the block below as well as the block above", () => {
    const built = chain("wallet-balance", "send");
    // Supply emits a vault share, which "send" cannot settle.
    expect(canInsert(built, block("supply"), 1)).toBe(false);
    expect(canInsert(built, block("swap"), 1)).toBe(true);
  });

  it("lets guards sit anywhere downstream of a source", () => {
    const built = chain("wallet-balance", "swap", "send");
    for (let i = 1; i <= built.length; i++) {
      expect(canInsert(built, block("guard-slippage"), i)).toBe(true);
    }
    expect(canInsert([], block("guard-slippage"), 0)).toBe(false);
  });
});

describe("compileChain", () => {
  it("flags a mismatched joint as blocking", () => {
    const result = compileChain(chain("wallet-balance", "stake"));
    expect(result.status).toBe("block");
    expect(result.joints[1].status).toBe("mismatch");
    expect(result.issues.some((issue) => issue.message.includes("LP position"))).toBe(true);
  });

  it("warns when a chain never settles", () => {
    const result = compileChain(chain("wallet-balance", "swap"));
    expect(result.issues.some((issue) => issue.message.includes("settles"))).toBe(true);
  });

  it("hashes params, not just block order", () => {
    const a = chain("wallet-balance", "guard-slippage");
    const b = chain("wallet-balance", "guard-slippage");
    expect(compileChain(a).hash).toBe(compileChain(b).hash);
    b[1].params.bps = 400;
    expect(compileChain(a).hash).not.toBe(compileChain(b).hash);
  });

  it("blocks an unbounded loop", () => {
    const looped = chain("recurring-stream", "guard-spend", "guard-window", "swap", "loop");
    looped[4].params.runs = 40;
    const result = compileChain(looped);
    expect(result.checks.find((check) => check.label === "Loop bound")?.status).toBe("block");
  });

  it("keeps a structurally valid but unguarded chain out of the block state", () => {
    const result = compileChain(chain("pending-rewards", "harvest", "send"));
    expect(result.guardScore).toBe(0);
    expect(result.status).toBe("warn");
    expect(result.checks.find((check) => check.label === "Connector fit")?.status).toBe("pass");
  });

  it("blocks slippage wider than the executor band", () => {
    const wide = chain("wallet-balance", "guard-slippage", "swap", "send");
    wide[1].params.bps = 400;
    expect(compileChain(wide).checks.find((check) => check.label === "Slippage")?.status).toBe("block");
  });
});

describe("canInsert agrees with compileChain", () => {
  // The canvas, the arrow buttons, and the palette dimming all trust canInsert.
  // If it ever green-lights a drop the compiler then rejects, the UI would
  // invite the user to build something it immediately calls broken.
  it("never accepts an insertion the compiler blocks", () => {
    const bases: ChainNode[][] = [
      [],
      chain("wallet-balance"),
      chain("wallet-balance", "swap", "send"),
      chain("wallet-balance", "add-liquidity", "stake", "hold"),
      chain("pending-rewards", "harvest", "send"),
      chain("wallet-balance", "supply", "borrow", "draw-debt", "send"),
    ];

    for (const base of bases) {
      for (const candidate of BLOCKS) {
        for (let index = 0; index <= base.length; index++) {
          if (!canInsert(base, candidate, index)) continue;
          const next = [...base];
          next.splice(index, 0, makeNode(candidate.id, `probe-${candidate.id}-${index}`));
          const blocked = compileChain(next).issues.filter((issue) => issue.level === "block");
          expect(blocked, `${candidate.id} at ${index} of [${base.map((n) => n.blockId).join(",")}]`).toEqual([]);
        }
      }
    }
  });
});

describe("scoreGuardCoverage", () => {
  it("is 100 when nothing risky is placed", () => {
    expect(scoreGuardCoverage([])).toBe(100);
  });

  it("demands a slippage cap once anything is priced", () => {
    // A source demands an expiry and the swap demands a slippage cap: 0 of 2.
    expect(scoreGuardCoverage([block("wallet-balance"), block("swap")])).toBe(0);
    expect(scoreGuardCoverage([block("wallet-balance"), block("swap"), block("guard-window")])).toBe(50);
    expect(scoreGuardCoverage([block("wallet-balance"), block("swap"), block("guard-slippage"), block("guard-window")])).toBe(100);
  });

  it("demands an oracle band for leverage", () => {
    const placed = [block("wallet-balance"), block("supply"), block("borrow"), block("guard-window")];
    expect(scoreGuardCoverage(placed)).toBe(50);
    expect(scoreGuardCoverage([...placed, block("guard-oracle")])).toBe(100);
  });
});

describe("recipes", () => {
  it("only references real blocks", () => {
    for (const recipe of RECIPES) {
      for (const [id] of recipe.blocks) expect(getBlock(id), `${recipe.id} -> ${id}`).toBeDefined();
    }
  });

  it("connects end to end", () => {
    for (const recipe of RECIPES) {
      const nodes = recipe.blocks.map(([id, params], index) => makeNode(id, `${recipe.id}-${index}`, params));
      const result = compileChain(nodes);
      expect(result.issues.filter((issue) => issue.level === "block"), recipe.id).toEqual([]);
    }
  });
});
