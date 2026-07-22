import { describe, expect, it } from "vitest";

import { compileChain, makeNode, type ChainNode, type ParamValue } from "@/lib/blocks";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  SLIPPAGE_STEP_BPS,
  reduceChainToLiveRoute,
} from "@/lib/deployable";

type Spec = [string, Record<string, ParamValue>?];

function chain(...specs: Spec[]): ChainNode[] {
  return specs.map(([id, params], index) => makeNode(id, `${id}-${index}`, params));
}

/** The one design the live contracts accept, in its buy direction. */
function buyChain(overrides: { source?: Record<string, ParamValue>; swap?: Record<string, ParamValue> } = {}): ChainNode[] {
  return chain(
    ["wallet-balance", { asset: "WETH", amount: "0.05", ...overrides.source }],
    ["guard-slippage", { bps: 50 }],
    ["swap", { into: "0xZAPS", venue: "Uniswap v4", ...overrides.swap }],
    ["send", { recipient: "owner wallet" }],
  );
}

function reasonsOf(nodes: ChainNode[]): string[] {
  const mapping = reduceChainToLiveRoute(nodes);
  if (mapping.deployable) throw new Error(`expected a rejection, got ${JSON.stringify(mapping)}`);
  return mapping.reasons;
}

describe("accepts the live route", () => {
  it("maps a WETH -> 0xZAPS design to a buy", () => {
    const mapping = reduceChainToLiveRoute(buyChain());
    expect(mapping).toEqual({
      deployable: true,
      direction: "buy",
      amountIn: "0.05",
      slippageBps: 50,
      unenforcedGuards: [],
    });
  });

  it("maps a 0xZAPS -> WETH design to a sell", () => {
    const mapping = reduceChainToLiveRoute(
      buyChain({ source: { asset: "0xZAPS", amount: "1200" }, swap: { into: "WETH" } }),
    );
    expect(mapping.deployable && mapping.direction).toBe("sell");
    expect(mapping.deployable && mapping.amountIn).toBe("1200");
  });

  it("accepts a design with no settlement block, because the policy settles to the owner anyway", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    expect(reduceChainToLiveRoute(nodes).deployable).toBe(true);
  });

  it("falls back to the app's default slippage when no cap is designed", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([]);
  });
});

describe("slippage", () => {
  it("clamps a cap above the signable range and says so", () => {
    const nodes = buyChain();
    nodes[1].params.bps = 900;
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.slippageBps).toBe(MAX_SLIPPAGE_BPS);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([
      `Slippage cap: 900 bps is outside the range the live app signs (${MIN_SLIPPAGE_BPS}–${MAX_SLIPPAGE_BPS} bps), so it will be deployed as ${MAX_SLIPPAGE_BPS} bps.`,
    ]);
  });

  it("clamps a cap below the signable range and says so", () => {
    const nodes = buyChain();
    nodes[1].params.bps = 1;
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.slippageBps).toBe(MIN_SLIPPAGE_BPS);
    expect(mapping.deployable && mapping.unenforcedGuards[0]).toContain(`deployed as ${MIN_SLIPPAGE_BPS} bps`);
  });

  // The builder's guard steps in 5 bps and the app's slider in 10, so an
  // in-range cap can still be one the app cannot hold.
  it("rounds a cap the app's control cannot express and says so", () => {
    const nodes = buyChain();
    nodes[1].params.bps = 75;
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.slippageBps).toBe(80);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([
      `Slippage cap: 75 bps is not one of the caps the live app can sign (it steps in ${SLIPPAGE_STEP_BPS} bps), so it will be deployed as 80 bps.`,
    ]);
  });

  it("never reports an in-range cap as unenforced", () => {
    const mapping = reduceChainToLiveRoute(buyChain());
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([]);
  });

  it("rejects a cap that is not a number", () => {
    const nodes = buyChain();
    nodes[1].params.bps = "wide";
    expect(reasonsOf(nodes)).toEqual(['Slippage cap "wide" is not a number of basis points.']);
  });
});

/**
 * Nothing stops a design carrying several caps — `canInsert` seats a guard
 * anywhere below the source, so tapping the palette chip twice stacks them, and
 * a shared link can encode any number. Whichever one governs decides what gets
 * signed, so it must be the safest one and it must be said out loud.
 */
describe("several slippage caps", () => {
  /** A buy design with the given caps stacked between the source and the swap. */
  function cappedChain(...bps: number[]): ChainNode[] {
    return chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ...bps.map((value): Spec => ["guard-slippage", { bps: value }]),
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["send", { recipient: "owner wallet" }],
    );
  }

  it("deploys the tightest cap, not the last one placed", () => {
    // Both are in range and on the app's grid, so neither is rounded: nothing
    // but this rule stops the 5.00% cap from being the one that ships.
    const mapping = reduceChainToLiveRoute(cappedChain(10, 500));
    expect(mapping.deployable && mapping.slippageBps).toBe(10);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([
      "Slippage cap: 2 caps are placed in this design (10 bps, 500 bps). Only the tightest governs, so this deploys with 10 bps and the other cap is not enforced.",
    ]);
  });

  it("names the dropped cap whichever order they were stacked in", () => {
    const loose = reduceChainToLiveRoute(cappedChain(500, 10));
    expect(loose.deployable && loose.slippageBps).toBe(10);
    expect(loose.deployable && loose.unenforcedGuards[0]).toContain("(500 bps, 10 bps)");
    expect(loose.deployable && loose.unenforcedGuards[0]).toContain("deploys with 10 bps");
  });

  it("governs from the tightest of three and counts the rest", () => {
    const mapping = reduceChainToLiveRoute(cappedChain(300, 20, 120));
    expect(mapping.deployable && mapping.slippageBps).toBe(20);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([
      "Slippage cap: 3 caps are placed in this design (300 bps, 20 bps, 120 bps). Only the tightest governs, so this deploys with 20 bps and the other 2 caps are not enforced.",
    ]);
  });

  it("discloses the value it deploys, not the first one it read", () => {
    // 15 rounds to 20 and 45 rounds to 50; only the tightest is deployed, so
    // 50 must never appear in the disclosure.
    const mapping = reduceChainToLiveRoute(cappedChain(15, 45));
    expect(mapping.deployable && mapping.slippageBps).toBe(20);
    if (!mapping.deployable) return;
    expect(mapping.unenforcedGuards).toEqual([
      "Slippage cap: 2 caps are placed in this design (15 bps, 45 bps). Only the tightest governs, so this deploys with 20 bps and the other cap is not enforced.",
      `Slippage cap: 15 bps is not one of the caps the live app can sign (it steps in ${SLIPPAGE_STEP_BPS} bps), so it will be deployed as 20 bps.`,
    ]);
    for (const note of mapping.unenforcedGuards) expect(note).not.toContain("50 bps");
  });

  it("is unchanged by where in the chain a cap sits", () => {
    const before = reduceChainToLiveRoute(cappedChain(30));
    const after = reduceChainToLiveRoute(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["guard-slippage", { bps: 30 }],
        ["send", { recipient: "owner wallet" }],
      ),
    );
    expect(after).toEqual(before);

    // And with two caps, above and below the swap, the tighter still governs.
    const straddling = reduceChainToLiveRoute(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["guard-slippage", { bps: 400 }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["guard-slippage", { bps: 30 }],
        ["send", { recipient: "owner wallet" }],
      ),
    );
    expect(straddling.deployable && straddling.slippageBps).toBe(30);
  });

  it("still reports one cap as a single cap, with no stacking note", () => {
    const mapping = reduceChainToLiveRoute(cappedChain(50));
    expect(mapping.deployable && mapping.slippageBps).toBe(50);
    expect(mapping.deployable && mapping.unenforcedGuards).toEqual([]);
  });

  it("rejects a design where any cap is not a number, whichever one it is", () => {
    const nodes = cappedChain(10, 500);
    nodes[2].params.bps = "wide";
    expect(reasonsOf(nodes)).toEqual(['Slippage cap "wide" is not a number of basis points.']);
  });
});

/**
 * The readout's Slippage check and the deploy CTA sit on the same screen. If
 * they read different guards, one of them is lying to someone about to sign.
 */
describe("the checks panel and the deploy handoff agree", () => {
  it("checks the cap that will actually be deployed", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-slippage", { bps: 10 }],
      ["guard-slippage", { bps: 500 }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["send", { recipient: "owner wallet" }],
    );
    const mapping = reduceChainToLiveRoute(nodes);
    const check = compileChain(nodes).checks.find((entry) => entry.label === "Slippage");
    expect(mapping.deployable && mapping.slippageBps).toBe(10);
    expect(check?.detail).toContain("the tightest, 10 bps, is the one that governs");
    expect(check?.status).toBe("pass");
  });

  it("does not call a design safe when the wide cap is the one that governs", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-slippage", { bps: 500 }],
      ["guard-slippage", { bps: 400 }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const mapping = reduceChainToLiveRoute(nodes);
    const compiled = compileChain(nodes);
    const check = compiled.checks.find((entry) => entry.label === "Slippage");
    expect(mapping.deployable && mapping.slippageBps).toBe(400);
    // Warn, not block: the live app signs 400 bps from its own slider, so this
    // is a risk to state plainly, not a reason to call the chain unbuildable.
    // Asserting "block" here is what pinned the contradiction the readout used
    // to show — "Will not compile" beside an enabled Deploy CTA for this exact
    // design. The warning still has to be unmistakable.
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("far too wide");
    expect(compiled.status).not.toBe("block");
  });
});

/**
 * A shared `?d=` token is validated for ids and param domains, not for
 * connectivity, so a chain that will not compile can still reach the readout.
 * Kind counts cannot see it — only the compiler can.
 */
describe("structural order", () => {
  it("rejects a swap placed above its source", () => {
    const reasons = reasonsOf(
      chain(["swap", { into: "0xZAPS", venue: "Uniswap v4" }], ["wallet-balance", { asset: "WETH", amount: "0.05" }]),
    );
    expect(reasons).toContain("This design does not compile, so it cannot be deployed: Swap needs a source above it.");
  });

  it("rejects a settlement block above the source", () => {
    const reasons = reasonsOf(
      chain(
        ["send", { recipient: "owner wallet" }],
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(reasons).toContain(
      "This design does not compile, so it cannot be deployed: Send to recipient needs a source above it.",
    );
  });

  it("rejects a joint that does not seat", () => {
    const reasons = reasonsOf(
      chain(
        ["pending-rewards"],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    );
    expect(reasons).toContain(
      "This design does not compile, so it cannot be deployed: Swap takes ERC-20 but receives Claimable.",
    );
  });

  it("never offers a deploy for a chain the compiler blocks", () => {
    const designs: ChainNode[][] = [
      chain(["swap", { into: "0xZAPS", venue: "Uniswap v4" }], ["wallet-balance", { asset: "WETH", amount: "0.05" }]),
      chain(
        ["send", { recipient: "owner wallet" }],
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["send", { recipient: "owner wallet" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    ];
    for (const design of designs) {
      const blocked = compileChain(design).issues.filter((issue) => issue.level === "block");
      expect(blocked.length, design.map((node) => node.blockId).join(" -> ")).toBeGreaterThan(0);
      expect(reduceChainToLiveRoute(design).deployable, design.map((node) => node.blockId).join(" -> ")).toBe(false);
    }
  });

  it("still accepts the live route in its normal order", () => {
    expect(reduceChainToLiveRoute(buyChain()).deployable).toBe(true);
  });
});

describe("unenforced guards", () => {
  it("names every guard the v1.1 policy does not bind", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-slippage", { bps: 50 }],
      ["guard-oracle", { band: 3 }],
      ["guard-window", { expiry: "30 days" }],
      ["guard-private"],
      ["guard-approval"],
      ["guard-spend", { cap: 1000 }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["send", { recipient: "owner wallet" }],
    );
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable).toBe(true);
    if (!mapping.deployable) return;

    expect(mapping.unenforcedGuards).toHaveLength(5);
    // Chain order, so the list reads in the order the user stacked the blocks.
    expect(mapping.unenforcedGuards[0]).toContain("Price band (±3%)");
    expect(mapping.unenforcedGuards[1]).toContain("Time window (30 days)");
    expect(mapping.unenforcedGuards[2]).toContain("Private submission");
    expect(mapping.unenforcedGuards[3]).toContain("Human gate");
    expect(mapping.unenforcedGuards[4]).toContain("Spend ceiling (1000)");
    for (const note of mapping.unenforcedGuards) expect(note).toContain("not enforced");
  });

  it("names a guard once even when it is placed twice", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-window", { expiry: "7 days" }],
      ["guard-window", { expiry: "90 days" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.unenforcedGuards).toHaveLength(1);
  });
});

describe("rejections", () => {
  it("rejects an empty design", () => {
    expect(reasonsOf([])).toEqual([
      "A live route starts from exactly one wallet balance; this design has no source.",
      "A live route is exactly one swap; this design has no action to deploy.",
    ]);
  });

  it("rejects a recurring source because a cadence is not expressible", () => {
    const nodes = chain(
      ["recurring-stream", { asset: "WETH", amount: "0.05", cadence: "weekly" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const reasons = reasonsOf(nodes);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("cadence is not expressible");
  });

  it("rejects a rewards source because it emits a claimable, not tokens", () => {
    const reasons = reasonsOf(chain(["pending-rewards"], ["swap", { into: "0xZAPS", venue: "Uniswap v4" }]));
    expect(reasons.some((reason) => reason.includes("emits a claimable, not tokens"))).toBe(true);
  });

  it("rejects two sources", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["recurring-stream"],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const reasons = reasonsOf(nodes);
    expect(reasons[0]).toContain("draws from exactly one source; this design has 2");
  });

  it("rejects a design with no action", () => {
    const reasons = reasonsOf(chain(["wallet-balance", { asset: "WETH", amount: "0.05" }]));
    expect(reasons).toEqual(["A live route is exactly one swap; this design has no action to deploy."]);
  });

  it("rejects more than one action", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["unwrap", { mode: "wrap" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const reasons = reasonsOf(nodes);
    expect(reasons[0]).toContain("exactly one step; this design has 2 actions");
    expect(reasons[1]).toContain("Wrap / unwrap has no adapter");
  });

  it("rejects an action that is not a swap", () => {
    const nodes = chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ["supply", { market: "Morpho" }]);
    expect(reasonsOf(nodes).some((reason) => reason.startsWith("Supply has no adapter"))).toBe(true);
  });

  it("rejects a venue with no adapter", () => {
    const reasons = reasonsOf(buyChain({ swap: { venue: "Aerodrome" } }));
    expect(reasons).toEqual(["The live adapter routes through Uniswap v4; this swap names Aerodrome, which has no adapter here."]);
  });

  it("rejects an asset pair that is not aeWETH <-> 0xZAPS, by name", () => {
    const reasons = reasonsOf(buyChain({ source: { asset: "USDC" }, swap: { into: "WETH" } }));
    expect(reasons).toEqual(["The live route only swaps aeWETH ↔ 0xZAPS. This design swaps USDC into WETH."]);
  });

  it("rejects a same-asset round trip", () => {
    const reasons = reasonsOf(buyChain({ swap: { into: "WETH" } }));
    expect(reasons[0]).toContain("This design swaps WETH into WETH");
  });

  it("rejects a send to a custom address", () => {
    const nodes = buyChain();
    nodes[3].params.recipient = "custom address";
    expect(reasonsOf(nodes)).toEqual([
      "Send to recipient uses a custom address, but the live policy hardcodes recipient = owner wallet. A capsule that settles anywhere else is not deployable here.",
    ]);
  });

  it("rejects a settlement block that is not a send", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["loop", { runs: 4 }],
    );
    expect(reasonsOf(nodes).some((reason) => reason.startsWith("Loop back cannot be deployed"))).toBe(true);
  });

  it("rejects two settlement blocks", () => {
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["send", { recipient: "owner wallet" }],
      ["send", { recipient: "owner wallet" }],
    );
    expect(reasonsOf(nodes)[0]).toContain("settles once; this design has 2 settlement blocks");
  });

  it("rejects a block this build does not ship", () => {
    const nodes = [makeNode("teleport", "x-0"), ...buyChain()];
    expect(reasonsOf(nodes)).toEqual(['This design references "teleport", which is not a block this build ships.']);
  });
});

describe("amount", () => {
  it("surfaces the router parser's own message", () => {
    const cases: Array<[string, string]> = [
      ["", "Enter a valid token amount."],
      ["abc", "Enter a valid token amount."],
      ["-1", "Enter a valid token amount."],
      ["0", "Amount must be greater than zero."],
      ["0.0000000000000000001", "Token amounts support at most 18 decimal places."],
    ];
    for (const [amount, message] of cases) {
      const reasons = reasonsOf(buyChain({ source: { amount } }));
      expect(reasons.some((reason) => reason.includes(message)), `${amount || "<empty>"} -> ${message}`).toBe(true);
    }
  });

  it("rejects an amount past the router's uint128 ceiling", () => {
    const reasons = reasonsOf(buyChain({ source: { amount: "999999999999999999999" } }));
    expect(reasons[0]).toContain("uint128");
  });

  it("keeps the decimal string the user typed", () => {
    const mapping = reduceChainToLiveRoute(buyChain({ source: { amount: " 0.000000000000000001 " } }));
    expect(mapping.deployable && mapping.amountIn).toBe("0.000000000000000001");
  });
});

describe("reason collection", () => {
  it("returns every reason, not just the first", () => {
    const nodes = chain(
      ["recurring-stream", { cadence: "daily" }],
      ["supply", { market: "Morpho" }],
      ["hold"],
    );
    const reasons = reasonsOf(nodes);
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain("cadence");
    expect(reasons[1]).toContain("Supply");
    expect(reasons[2]).toContain("Hold in zap");
  });
});

describe("the CTA and the verdict can never contradict each other", () => {
  /**
   * The property behind two separate review findings: the builder rendered
   * "Will not compile" beside an enabled Deploy CTA. Once through a share link
   * carrying blocks in an impossible order, and once through a slippage cap
   * above 250 bps that the live contracts sign perfectly happily.
   *
   * Both were symptoms of the same missing invariant, so the invariant is what
   * gets pinned here rather than the two shapes that happened to expose it.
   */
  const CAPS = [MIN_SLIPPAGE_BPS, 50, 100, 250, 260, 400, MAX_SLIPPAGE_BPS];

  it("never offers to deploy a chain it calls structurally broken", () => {
    const candidates: ChainNode[][] = [
      ...CAPS.map((bps) =>
        chain(
          ["wallet-balance", { asset: "WETH", amount: "0.05" }],
          ["guard-slippage", { bps }],
          ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
          ["send", { recipient: "owner wallet" }],
        ),
      ),
      // Orders a share link can carry that dragging would never produce.
      chain(
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ),
      chain(
        ["send", { recipient: "owner wallet" }],
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ),
    ];

    for (const nodes of candidates) {
      const mapping = reduceChainToLiveRoute(nodes);
      if (!mapping.deployable) continue;
      const compiled = compileChain(nodes);
      const shape = nodes.map((node) => node.blockId).join(" -> ");
      expect(compiled.status, `deployable but status=block: ${shape}`).not.toBe("block");
      expect(compiled.issues.filter((issue) => issue.level === "block"), shape).toEqual([]);
    }
  });

  it("still deploys every cap the live app can sign", () => {
    for (const bps of CAPS) {
      const mapping = reduceChainToLiveRoute(
        chain(
          ["wallet-balance", { asset: "WETH", amount: "0.05" }],
          ["guard-slippage", { bps }],
          ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
          ["send", { recipient: "owner wallet" }],
        ),
      );
      expect(mapping.deployable, `${bps} bps should deploy`).toBe(true);
      expect(mapping.deployable && mapping.slippageBps).toBe(bps);
    }
  });
});
