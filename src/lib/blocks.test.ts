import { describe, expect, it } from "vitest";

import {
  BLOCKS,
  RECIPES,
  canInsert,
  compileChain,
  decodeChain,
  encodeChain,
  getBlock,
  makeNode,
  resolveSlippageGuards,
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

  it("gives every param a default of its own declared type", () => {
    for (const entry of BLOCKS) {
      for (const param of entry.params) {
        const expected = param.type === "number" ? "number" : "string";
        expect(typeof param.value, `${entry.id}.${param.key}`).toBe(expected);
      }
    }
  });

  it("carries token amounts as decimal strings, not slider positions", () => {
    // A slider that steps in tens cannot reach 0.05 aeWETH, which is the size a
    // real Robinhood Chain zap actually carries.
    for (const id of ["wallet-balance", "recurring-stream"]) {
      const param = block(id).params.find((entry) => entry.key === "amount");
      expect(param?.type, id).toBe("amount");
    }
    expect(block("wallet-balance").params.find((entry) => entry.key === "amount")?.value).toBe("0.05");
  });

  it("can express both directions of the live pair", () => {
    const asset = block("wallet-balance").params.find((entry) => entry.key === "asset");
    expect(asset?.type === "select" && asset.options).toContain("0xZAPS");
    expect(asset?.type === "select" && asset.options).toContain("WETH");
    // The stored value stays "WETH"; the copy is what carries the aeWETH truth.
    expect(block("wallet-balance").detail).toContain("aeWETH");
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

  it("warns about slippage wider than the executor band without calling it a fault", () => {
    // This check used to return "block", which made the readout say "will not
    // compile" beside a deploy CTA correctly offering a cap the live contracts
    // sign — the app's own slider goes to 500 bps. A wide cap is a risk the
    // user may legitimately take; "block" is reserved for structural faults.
    const wide = chain("wallet-balance", "guard-slippage", "swap", "send");
    wide[1].params.bps = 400;
    const result = compileChain(wide);
    expect(result.checks.find((check) => check.label === "Slippage")?.status).toBe("warn");
    expect(result.status).not.toBe("block");
    expect(result.issues.filter((issue) => issue.level === "block")).toEqual([]);
  });

  it("checks the tightest cap when a design states several", () => {
    // Chain order used to decide this, which let the readout tick a 0.10% cap
    // green while the deploy handoff carried the 5.00% one.
    const stacked = chain("wallet-balance", "guard-slippage", "guard-slippage", "swap", "send");
    stacked[1].params.bps = 10;
    stacked[2].params.bps = 500;
    const check = compileChain(stacked).checks.find((entry) => entry.label === "Slippage");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("2 caps are placed (10 bps, 500 bps)");
    expect(check?.detail).toContain("the tightest, 10 bps, is the one that governs");

    // Same two caps, opposite order: same verdict.
    const flipped = chain("wallet-balance", "guard-slippage", "guard-slippage", "swap", "send");
    flipped[1].params.bps = 500;
    flipped[2].params.bps = 10;
    expect(compileChain(flipped).checks.find((entry) => entry.label === "Slippage")?.status).toBe("pass");
  });

  it("codes the structural faults so callers can act on them", () => {
    const orphaned = compileChain(chain("swap", "wallet-balance"));
    expect(orphaned.issues.find((issue) => issue.code === "orphan")?.message).toBe("Swap needs a source above it.");
    expect(orphaned.issues.some((issue) => issue.code === "duplicate-source")).toBe(true);
    expect(compileChain(chain("wallet-balance", "stake")).issues.some((issue) => issue.code === "mismatch")).toBe(true);
    expect(compileChain([makeNode("teleport", "x")]).issues.some((issue) => issue.code === "unknown-block")).toBe(true);
  });
});

describe("resolveSlippageGuards", () => {
  it("returns nothing when no cap is placed", () => {
    expect(resolveSlippageGuards(chain("wallet-balance", "swap"))).toEqual({
      caps: [],
      invalid: [],
      governingBps: null,
    });
  });

  it("keeps every cap in chain order and governs by the tightest", () => {
    const nodes = chain("wallet-balance", "guard-slippage", "guard-slippage", "guard-slippage", "swap");
    nodes[1].params.bps = 300;
    nodes[2].params.bps = 20;
    nodes[3].params.bps = 120;
    expect(resolveSlippageGuards(nodes)).toEqual({ caps: [300, 20, 120], invalid: [], governingBps: 20 });
  });

  it("separates a cap that is not a number from the ones that are", () => {
    const nodes = chain("wallet-balance", "guard-slippage", "guard-slippage", "swap");
    nodes[1].params.bps = "wide";
    nodes[2].params.bps = 40;
    expect(resolveSlippageGuards(nodes)).toEqual({ caps: [40], invalid: ["wide"], governingBps: 40 });
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

  it("overrides params with the type the catalog declares", () => {
    for (const recipe of RECIPES) {
      for (const [id, params] of recipe.blocks) {
        for (const [key, value] of Object.entries(params ?? {})) {
          const param = block(id).params.find((entry) => entry.key === key);
          expect(param, `${recipe.id} -> ${id}.${key}`).toBeDefined();
          const expected = param?.type === "number" ? "number" : "string";
          expect(typeof value, `${recipe.id} -> ${id}.${key}`).toBe(expected);
        }
      }
    }
  });
});

describe("sharing", () => {
  const shared = (): ChainNode[] => [
    makeNode("wallet-balance", "p1", { asset: "0xZAPS", amount: "12.5" }),
    makeNode("guard-slippage", "p2", { bps: 25 }),
    makeNode("swap", "p3", { into: "WETH" }),
    makeNode("send", "p4"),
  ];

  it("round-trips a chain without losing anything", () => {
    const chainToShare = shared();
    const decoded = decodeChain(encodeChain(chainToShare));
    expect(decoded).toEqual(chainToShare);
  });

  it("produces a URL-safe token", () => {
    expect(encodeChain(shared())).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips an empty chain", () => {
    expect(decodeChain(encodeChain([]))).toEqual([]);
  });

  it("returns null on garbage", () => {
    for (const token of ["", "!!!!", "not base64url ✨", encodeChain(shared()).slice(0, 5), "eyJhIjoxfQ"]) {
      expect(decodeChain(token), token).toBeNull();
    }
  });

  it("drops a node whose block this build does not ship", () => {
    const token = encodeChain([
      makeNode("wallet-balance", "p1", { asset: "WETH" }),
      { uid: "p2", blockId: "teleport", params: { destination: "moon" } },
      makeNode("swap", "p3"),
    ]);
    const decoded = decodeChain(token);
    expect(decoded?.map((node) => node.blockId)).toEqual(["wallet-balance", "swap"]);
  });

  it("never trusts a param the catalog does not declare", () => {
    // The token comes from a URL a stranger can craft, so the catalog — not the
    // token — decides which keys and values a node may carry.
    const token = encodeChain([
      // A computed key so `__proto__` lands as a real own property, the way it
      // would after JSON.parse of a hand-written token.
      { uid: "p1", blockId: "guard-slippage", params: { bps: 90_000, ["__proto__"]: "x", stolen: "yes" } },
    ]);
    const decoded = decodeChain(token);
    expect(decoded?.[0].params).toEqual({ bps: 500 });
  });

  it("falls back to the catalog default for an out-of-domain select", () => {
    const token = encodeChain([{ uid: "p1", blockId: "swap", params: { into: "SCAMCOIN", venue: "Uniswap v3" } }]);
    expect(decodeChain(token)?.[0].params).toEqual({ into: "WETH", venue: "Uniswap v3" });
  });

  it("rejects an amount that is not a decimal number", () => {
    const token = encodeChain([{ uid: "p1", blockId: "wallet-balance", params: { amount: "1e9", asset: "WETH" } }]);
    expect(decodeChain(token)?.[0].params.amount).toBe("0.05");
  });

  it("gives repeated uids their own identity", () => {
    const token = encodeChain([makeNode("wallet-balance", "same"), makeNode("swap", "same")]);
    const decoded = decodeChain(token);
    expect(new Set(decoded?.map((node) => node.uid)).size).toBe(2);
  });
});
