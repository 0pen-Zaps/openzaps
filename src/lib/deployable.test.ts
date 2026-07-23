import { afterEach, describe, expect, it } from "vitest";

import { RECIPES, compileChain, getBlock, makeNode, type ChainNode, type ParamValue } from "@/lib/blocks";
import {
  BOUNDED_SWAP_IDS,
  MAX_POLICY_STEPS,
  ROBINHOOD_ADAPTERS,
  adapterAddress,
  deployedAdapters,
  findDeployedAdapter,
  isAdapterDeployed,
  onlyBoundedSwapIsDeployed,
  type AdapterSet,
} from "@/lib/chains";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  SLIPPAGE_STEP_BPS,
  reduceChainToLivePolicy,
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
      routeId: "robinhood-v4-weth-zaps",
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
    // With more than the bounded swap deployed, the multi-step vocabulary is
    // active, so the no-action message is the general one.
    expect(reasonsOf([])).toEqual([
      "A live route starts from exactly one wallet balance; this design has no source.",
      "A deployable policy needs at least one action; this design has none.",
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
    expect(reasons).toEqual(["A deployable policy needs at least one action; this design has none."]);
  });

  it("rejects an action with no deployed adapter", () => {
    // The step budget is now MAX (a non-bounded adapter is deployed), so what
    // rejects this is the missing `unwrap` adapter, not a one-step limit.
    const nodes = chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["unwrap", { mode: "wrap" }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
    );
    const reasons = reasonsOf(nodes);
    expect(reasons.some((reason) => reason.includes("Wrap / unwrap has no adapter"))).toBe(true);
  });

  it("rejects a supply into a protocol no deployed adapter is welded to", () => {
    const nodes = chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ["supply", { market: "Morpho" }]);
    // The vault adapter takes USDG, not WETH, so this supply is handed an asset
    // no deployed adapter accepts.
    expect(reasonsOf(nodes).some((reason) => reason.includes("Supply is handed WETH, and no adapter here takes that"))).toBe(true);
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
    // The recurring source cannot open a route, so the asset flowing into Supply
    // is unknown and that step is skipped silently (a rejection derived from an
    // asset nobody knows would be noise). Source and sink are the two reasons.
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("cadence");
    expect(reasons[1]).toContain("Hold in zap");
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

describe("the Live route blueprint", () => {
  // The builder opens on this blueprint and offers it as the one chain today's
  // contracts can carry. It is the front door to the only thing this product
  // actually does, so a catalog edit that quietly drops it off the live route —
  // a renamed venue, a retired asset, a changed default — has to fail here
  // rather than in front of someone who tapped "Deploy" and found nothing.
  const recipe = RECIPES.find((entry) => entry.id === "live-route");

  it("exists and is the chain the builder opens on", () => {
    expect(recipe).toBeDefined();
    expect(RECIPES[0].id).toBe("live-route");
  });

  it("reduces to the live route with no rejections", () => {
    const nodes = (recipe?.blocks ?? []).map(([id, params], index) =>
      makeNode(id, `live-route-${index}`, params),
    );
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable, mapping.deployable ? "" : mapping.reasons.join(" | ")).toBe(true);
    expect(mapping.deployable && mapping.direction).toBe("buy");
  });

  it("is the only blueprint that reduces to the live route", () => {
    // The blueprint row badges exactly the deployable ones and the copy beside
    // it says there is one such shape. Both are read off this.
    const deployable = RECIPES.filter((entry) =>
      reduceChainToLiveRoute(
        entry.blocks.map(([id, params], index) => makeNode(id, `${entry.id}-${index}`, params)),
      ).deployable,
    ).map((entry) => entry.id);
    expect(deployable).toEqual(["live-route"]);
  });

  it("states a slippage cap the live app can sign without rounding it", () => {
    // A cap the app cannot hold gets stepped on the way over and disclosed as
    // changed. The blueprint should not be the thing that triggers that notice.
    const nodes = (recipe?.blocks ?? []).map(([id, params], index) =>
      makeNode(id, `live-route-${index}`, params),
    );
    const mapping = reduceChainToLiveRoute(nodes);
    expect(mapping.deployable && mapping.unenforcedGuards.filter((note) => note.startsWith("Slippage cap:"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The deployed-adapter registry, and what it is allowed to change.
//
// `chains.ts` is the only thing that decides what this build offers. The four
// expansion adapters (USDG swap both sides, vault deposit, vault redeem) now
// carry baked addresses because they are deployed and allowlisted on chain 4663,
// so the default deployed set is the full six. The env var still overrides the
// baked address, and a MALFORMED env value fails closed by dropping that one
// route — never by widening what is offered.
// ---------------------------------------------------------------------------

/** Any well-formed address; the registry only cares that one is configured. */
const VAULT_DEPOSIT_ADDRESS = "0x1111111111111111111111111111111111111111";

const ADAPTER_ENV = [
  "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER",
  "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER",
  "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER",
] as const;

afterEach(() => {
  // Env leaking between tests would make one test's configured adapter widen
  // another test's "nothing is deployed" baseline — which is the exact claim
  // most of this file exists to check.
  for (const key of ADAPTER_ENV) delete process.env[key];
});

function configureVaultDeposit(address: string = VAULT_DEPOSIT_ADDRESS): void {
  process.env.NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER = address;
}

function policyReasons(nodes: ChainNode[], adapters?: AdapterSet): string[] {
  const mapping = reduceChainToLivePolicy(nodes, adapters);
  if (mapping.deployable) throw new Error(`expected a rejection, got ${JSON.stringify(mapping)}`);
  return mapping.reasons;
}

describe("the deployed-adapter registry", () => {
  it("deploys the full baked adapter set — bounded swap, USDG swap, and both vault legs", () => {
    expect(deployedAdapters().map((adapter) => adapter.id)).toEqual([
      "robinhood-v4-weth-zaps",
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
      "robinhood-v4-usdg-weth",
      "robinhood-zap-vault-deposit",
      "robinhood-zap-vault-redeem",
    ]);
    // A non-bounded, reachable adapter is deployed, so the one-route world is over.
    expect(onlyBoundedSwapIsDeployed()).toBe(false);
  });

  it("treats every baked expansion adapter as deployed", () => {
    for (const spec of ROBINHOOD_ADAPTERS) {
      expect(isAdapterDeployed(spec), spec.id).toBe(true);
      expect(adapterAddress(spec), spec.id).not.toBeNull();
    }
  });

  it("uses the baked address, and lets an env var override it", () => {
    const vault = ROBINHOOD_ADAPTERS.find((spec) => spec.id === "robinhood-zap-vault-deposit");
    expect(vault).toBeDefined();
    if (!vault) return;

    const baked = adapterAddress(vault);
    expect(isAdapterDeployed(vault)).toBe(true);
    expect(baked).not.toBeNull();
    configureVaultDeposit();
    expect(adapterAddress(vault)).toBe(VAULT_DEPOSIT_ADDRESS);
    expect(adapterAddress(vault)).not.toBe(baked);
  });

  // A malformed value must never widen what the builder claims. Being wrongly
  // rejected costs a user one env fix; being wrongly offered costs them a
  // capsule that reverts, or worse, one that does something else. A malformed
  // env now DROPS the route (its baked address is overridden by the bad value).
  it("fails closed on a value that is not a live address, dropping that route", () => {
    for (const bad of ["", "0x0", "not-an-address", "0x0000000000000000000000000000000000000000", "0x1234"]) {
      configureVaultDeposit(bad);
      expect(
        deployedAdapters().map((adapter) => adapter.id),
        bad || "<empty>",
      ).not.toContain("robinhood-zap-vault-deposit");
    }
  });

  it("finds the baked vault-deposit adapter, and honours an env override", () => {
    const query = { blockId: "supply", tokenIn: "USDG", params: { market: "ZapVault" } };
    expect(findDeployedAdapter(query)?.id).toBe("robinhood-zap-vault-deposit");
    configureVaultDeposit();
    expect(findDeployedAdapter(query)?.address).toBe(VAULT_DEPOSIT_ADDRESS);
  });

  it("will not answer a query for a protocol or asset it is not welded to", () => {
    configureVaultDeposit();
    // The weld is the whole safety property: an adapter's vault and asset are
    // immutable constructor args, so a USDG ZapVault adapter answering either
    // of these would be the registry lying about what an address does.
    expect(findDeployedAdapter({ blockId: "supply", tokenIn: "USDG", params: { market: "Morpho" } })).toBeNull();
    expect(findDeployedAdapter({ blockId: "supply", tokenIn: "0xZAPS", params: { market: "ZapVault" } })).toBeNull();
  });

  it("names blocks and params that exist in the catalog", () => {
    for (const spec of ROBINHOOD_ADAPTERS) {
      if (spec.blockId === null) continue;
      const block = getBlock(spec.blockId);
      // A typo here would not fail loudly — it would silently make the adapter
      // unreachable, i.e. an adapter that IS deployed and never offered.
      expect(block, spec.id).toBeDefined();
      for (const key of Object.keys(spec.weldedParams)) {
        expect(block?.params.some((param) => param.key === key), `${spec.id} welds ${key}`).toBe(true);
      }
    }
  });

  it("welds the vault to a market and an asset the catalog cannot select", () => {
    // Deliberate, and pinned so it cannot drift unnoticed. `supply` offers
    // Morpho, Aave v3 and Compound v3 — none of which is on Robinhood Chain —
    // and no source offers USDG, which is what the deploy script's vault takes.
    // So configuring the address alone does NOT put a vault step in front of a
    // user: teaching the catalog these names is a separate change, and it is
    // the one that has to carry the copy for what a vault deposit does. Until
    // then a design that says "Morpho" can never be deployed as something else.
    // The catalog now names both, which is what makes a vault chain drawable at
    // all. Configuring the address is still not sufficient on its own — the
    // adapter has to be deployed AND allowlisted — but the names are no longer
    // the thing standing in the way, so this asserts they are present and the
    // reachability tests below carry the "is it actually deployable" question.
    const market = getBlock("supply")?.params.find((param) => param.key === "market");
    expect(market?.type === "select" && market.options).toContain("ZapVault");
    const asset = getBlock("wallet-balance")?.params.find((param) => param.key === "asset");
    expect(asset?.type === "select" && asset.options).toContain("USDG");
    // And the copy must not promise yield the vault does not pay.
    expect(getBlock("supply")?.detail).toContain("earns nothing at all");
  });
});

describe("with the expansion adapters deployed, the mapper still refuses the impossible", () => {
  it("rejects a swap-then-supply design because the vault takes USDG, not 0xZAPS", () => {
    const reasons = reasonsOf(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["supply", { market: "ZapVault", amount: "100" }],
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Supply is handed 0xZAPS, and no adapter here takes that");
    expect(reasons[0]).toContain("OpenZap USDG Vault deposit (takes USDG, welded to market ZapVault)");
  });

  it("rejects a round-trip swap that spends the asset it settles in", () => {
    const reasons = reasonsOf(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["swap", { into: "WETH", venue: "Uniswap v4", amount: "100" }],
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Step 1 (Swap) spends WETH, and WETH is also what this design settles in");
  });

  it("emits a single-step policy for the live route, with the deployed adapter on it", () => {
    const policy = reduceChainToLivePolicy(buyChain());
    expect(policy.deployable).toBe(true);
    if (!policy.deployable) return;

    expect(policy.steps).toHaveLength(1);
    expect(policy.steps[0]).toMatchObject({
      position: 1,
      blockId: "swap",
      adapterId: "robinhood-v4-weth-zaps",
      kind: "swap",
      tokenIn: "WETH",
      tokenOut: "0xZAPS",
      amountIn: "0.05",
      direction: "buy",
    });
    expect(policy.steps[0].adapterAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(policy.outAsset).toBe("0xZAPS");
    expect(policy.direction).toBe("buy");
    // One step has no boundary, so there is nothing to strand and nothing to
    // warn about. A stray notice here would be crying wolf on the one design
    // this product actually ships.
    expect(policy.notices).toEqual([]);
  });

  it("routes a sell through the other side of the same pool", () => {
    const policy = reduceChainToLivePolicy(
      buyChain({ source: { asset: "0xZAPS", amount: "1200" }, swap: { into: "WETH" } }),
    );
    const buy = reduceChainToLivePolicy(buyChain());
    if (!policy.deployable || !buy.deployable) throw new Error("both directions must reduce to a policy");

    expect(policy.steps[0].adapterId).toBe("robinhood-v4-zaps-weth");
    expect(policy.direction).toBe("sell");
    // Same contract, both directions — the adapter picks its side from the
    // token it is handed, so allowlisting one address covers the pair.
    expect(policy.steps[0].adapterAddress).toBe(buy.steps[0].adapterAddress);
  });
});

/**
 * What changes, and what does not, once a real vault adapter is configured.
 *
 * The vault the deploy script builds takes USDG, and nothing in the deployed
 * set produces USDG, so configuring it does NOT make a two-step design
 * reachable. These tests pin that — an address alone changes nothing a user
 * can draw — and the fixture suite below proves the multi-step reduction
 * itself.
 */
describe("with the real vault adapter configured", () => {
  it("still refuses to deposit an asset the vault is not welded to", () => {
    configureVaultDeposit();
    const reasons = policyReasons(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["supply", { market: "ZapVault", amount: "100" }],
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Supply is handed 0xZAPS, and no adapter here takes that");
    expect(reasons[0]).toContain("OpenZap USDG Vault deposit (takes USDG, welded to market ZapVault)");
  });

  it("refuses a policy that spends the asset it settles in", () => {
    configureVaultDeposit();
    // aeWETH -> 0xZAPS -> aeWETH, through the two sides of the one deployed
    // pool. Both steps have an adapter and both amounts are stated, so nothing
    // else catches it: what catches it is the capsule's own settlement rule,
    // which snapshots one balance before the loop and subtracts it after.
    const reasons = policyReasons(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["swap", { into: "WETH", venue: "Uniswap v4", amount: "100" }],
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Step 1 (Swap) spends WETH, and WETH is also what this design settles in");
    expect(reasons[0]).toContain("reverts unless the round trip comes back profitable");
  });

  it("maps a single vault deposit, and hands it to the deploy page by route id", () => {
    configureVaultDeposit();
    // A `[wallet-balance USDG] → [supply ZapVault]` chain IS drawable now (the
    // catalog names both), and with the adapter deployed it reduces to a single
    // vault-deposit step. The deploy page signs single-step capsules by route
    // id, so it is handed off — /app applies the vault seeding gate on import.
    const nodes = chain(
      ["wallet-balance", { asset: "USDG", amount: "500" }],
      ["supply", { market: "ZapVault", amount: "500" }],
    );
    const policy = reduceChainToLivePolicy(nodes);
    expect(policy.deployable, policy.deployable ? "" : policy.reasons.join(" | ")).toBe(true);
    if (!policy.deployable) return;

    expect(policy.steps).toHaveLength(1);
    expect(policy.steps[0]).toMatchObject({
      adapterId: "robinhood-zap-vault-deposit",
      adapterAddress: VAULT_DEPOSIT_ADDRESS,
      kind: "vault-deposit",
      tokenIn: "USDG",
      tokenOut: "ozUSDG",
      amountIn: "500",
    });
    expect(policy.direction).toBeNull();
    expect(policy.outAsset).toBe("ozUSDG");

    const route = reduceChainToLiveRoute(nodes);
    expect(route.deployable).toBe(true);
    expect(route.deployable && route.routeId).toBe("robinhood-zap-vault-deposit");
    // No single buy/sell direction for a vault route — /app resolves it by id.
    expect(route.deployable && route.direction).toBeNull();
    // The CTA carries the seeding disclosure verbatim — deployable.ts cannot read
    // the vault, so it must not read as a promise the /app seed gate will refuse.
    expect(route.deployable && route.unenforcedGuards[0]).toContain("deploys only while the vault is seeded");
  });

  it("leaves the live route, and every guard disclosure on it, untouched", () => {
    configureVaultDeposit();
    // The route the app already signs must be byte-identical, now with its
    // route id carried alongside the legacy direction.
    expect(reduceChainToLiveRoute(buyChain())).toEqual({
      deployable: true,
      routeId: "robinhood-v4-weth-zaps",
      direction: "buy",
      amountIn: "0.05",
      slippageBps: 50,
      unenforcedGuards: [],
    });
  });

  it("does not turn any other blueprint into a deployable one", () => {
    configureVaultDeposit();
    const deployable = RECIPES.filter((entry) =>
      reduceChainToLiveRoute(
        entry.blocks.map(([id, params], index) => makeNode(id, `${entry.id}-${index}`, params)),
      ).deployable,
    ).map((entry) => entry.id);
    expect(deployable).toEqual(["live-route"]);
  });
});

/**
 * The multi-step reduction, against a FIXTURE adapter set.
 *
 * No two adapters in the real registry chain into a policy that settles: the
 * deployed pair round-trips one pool, and the vault takes an asset nothing
 * produces. So the two-step machinery is exercised here against a set that
 * exists only in this file. It is passed in explicitly — `ROBINHOOD_ADAPTERS`
 * is never mutated — so no fictional adapter can reach the shipped registry,
 * which is the file that decides what the product claims.
 */
describe("multi-step, against a deployed adapter set", () => {
  const FIXTURE_VAULT_ADDRESS = "0x2222222222222222222222222222222222222222";

  const FIXTURE_ADAPTERS: AdapterSet = [
    ...ROBINHOOD_ADAPTERS.filter((spec) => BOUNDED_SWAP_IDS.includes(spec.id)),
    {
      id: "fixture-zaps-vault-deposit",
      chainId: ROBINHOOD_ADAPTERS[0].chainId,
      kind: "vault-deposit",
      label: "Fixture 0xZAPS vault deposit",
      blockId: "supply",
      weldedParams: { market: "ZapVault" },
      tokenIn: "0xZAPS",
      tokenOut: "fzZAPS",
      direction: null,
      envVar: "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER",
      deployedAddress: FIXTURE_VAULT_ADDRESS,
      refuses: "Fixture. Nothing is deployed at this address.",
    },
  ];

  /** A swap into 0xZAPS followed by a vault deposit of a stated amount. */
  function vaultChain(supply: Record<string, ParamValue> = {}): ChainNode[] {
    return chain(
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-slippage", { bps: 50 }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["supply", { market: "ZapVault", amount: "100", ...supply }],
    );
  }

  it("reduces swap-then-deposit to a two-step policy", () => {
    const policy = reduceChainToLivePolicy(vaultChain(), FIXTURE_ADAPTERS);
    expect(policy.deployable, policy.deployable ? "" : policy.reasons.join(" | ")).toBe(true);
    if (!policy.deployable) return;

    expect(
      policy.steps.map((step) => [step.position, step.adapterId, step.tokenIn, step.tokenOut, step.amountIn]),
    ).toEqual([
      [1, "robinhood-v4-weth-zaps", "WETH", "0xZAPS", "0.05"],
      [2, "fixture-zaps-vault-deposit", "0xZAPS", "fzZAPS", "100"],
    ]);
    expect(policy.steps[1].adapterAddress).toBe(FIXTURE_VAULT_ADDRESS);
    expect(policy.steps[1].kind).toBe("vault-deposit");
    expect(policy.outAsset).toBe("fzZAPS");
    // The pull the owner funds and signs is still step 1's.
    expect(policy.amountIn).toBe("0.05");
    // Two steps have no single direction, and calling this one a "buy" would
    // describe a fraction of what gets signed.
    expect(policy.direction).toBeNull();
    // Every guard disclosure keeps working across a longer policy.
    expect(policy.slippageBps).toBe(50);
  });

  it("names the step whose surplus strands, the amount, and the exit", () => {
    const policy = reduceChainToLivePolicy(vaultChain(), FIXTURE_ADAPTERS);
    expect(policy.deployable).toBe(true);
    if (!policy.deployable) return;

    expect(policy.notices).toHaveLength(1);
    const [notice] = policy.notices;
    expect(notice).toContain("Step 2 (Supply) spends exactly 100 0xZAPS");
    expect(notice).toContain("frozen into the policy when you sign it");
    expect(notice).toContain("Step 1 (Swap)");
    expect(notice).toContain("stays in the capsule");
    expect(notice).toContain("emergency exit");
    expect(notice).toContain("nothing sweeps it back automatically");
    // The other half of a frozen amount: too little is not a smaller zap, it
    // is a reverted one.
    expect(notice).toContain("the whole zap reverts");
  });

  it("quotes the amount that will be signed, never the size drawn upstream", () => {
    const policy = reduceChainToLivePolicy(vaultChain({ amount: "40" }), FIXTURE_ADAPTERS);
    expect(policy.deployable && policy.notices).toHaveLength(1);
    expect(policy.deployable && policy.notices[0]).toContain("spends exactly 40 0xZAPS");
    expect(policy.deployable && policy.notices[0]).not.toContain("0.05");
  });

  it("refuses a step that states no amount of its own", () => {
    const reasons = policyReasons(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["supply", { market: "ZapVault" }],
      ),
      FIXTURE_ADAPTERS,
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Supply is step 2 of this design and states no amount of its own");
    expect(reasons[0]).toContain("a step cannot spend what the step above it produced");
  });

  it("refuses a step amount the router would not accept", () => {
    for (const [amount, message] of [
      ["0", "Amount must be greater than zero."],
      ["abc", "Enter a valid token amount."],
      ["0.0000000000000000001", "Token amounts support at most 18 decimal places."],
      ["999999999999999999999", "uint128"],
    ] as Array<[string, string]>) {
      const reasons = policyReasons(vaultChain({ amount }), FIXTURE_ADAPTERS);
      expect(reasons.some((reason) => reason.includes(message)), amount).toBe(true);
      expect(reasons.some((reason) => reason.includes("is step 2")), amount).toBe(true);
    }
  });

  it("refuses to deploy a market the adapter is not welded to", () => {
    const reasons = policyReasons(vaultChain({ market: "Morpho" }), FIXTURE_ADAPTERS);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Supply names market Morpho");
    expect(reasons[0]).toContain("welded to market ZapVault");
    expect(reasons[0]).toContain("fixed when it is deployed");
  });

  it("still refuses a block no adapter executes, and says what it can deploy", () => {
    const reasons = policyReasons(
      chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ["unwrap", { mode: "wrap" }]),
      FIXTURE_ADAPTERS,
    );
    expect(reasons[0]).toContain("Wrap / unwrap has no adapter on the live route");
    expect(reasons[0]).toContain("Fixture 0xZAPS vault deposit");
  });

  it("refuses more steps than the capsule walks", () => {
    const swaps: Spec[] = Array.from({ length: MAX_POLICY_STEPS + 1 }, () => [
      "swap",
      { into: "0xZAPS", venue: "Uniswap v4", amount: "1" },
    ]);
    const reasons = policyReasons(
      chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ...swaps),
      FIXTURE_ADAPTERS,
    );
    expect(reasons.some((reason) => reason.includes(`walks at most ${MAX_POLICY_STEPS} steps`))).toBe(true);
  });

  it("keeps forcing the recipient, however many steps there are", () => {
    const reasons = policyReasons(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["supply", { market: "ZapVault", amount: "100" }],
        ["hold"],
      ),
      FIXTURE_ADAPTERS,
    );
    expect(reasons.some((reason) => reason.startsWith("Hold in zap cannot be deployed"))).toBe(true);
  });

  it("keeps naming every unenforced guard across a longer policy", () => {
    const policy = reduceChainToLivePolicy(
      chain(
        ["wallet-balance", { asset: "WETH", amount: "0.05" }],
        ["guard-window", { expiry: "30 days" }],
        ["guard-approval"],
        ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
        ["supply", { market: "ZapVault", amount: "100" }],
      ),
      FIXTURE_ADAPTERS,
    );
    expect(policy.deployable).toBe(true);
    if (!policy.deployable) return;
    expect(policy.unenforcedGuards).toHaveLength(2);
    expect(policy.unenforcedGuards[0]).toContain("Time window (30 days)");
    expect(policy.unenforcedGuards[1]).toContain("Human gate");
    // Guards and notices stay separate lists: one is about what the policy
    // does not bind, the other about what the policy does.
    expect(policy.notices).toHaveLength(1);
  });

  it("never emits a partial policy when one step of it fails", () => {
    // Step 2 has no amount, so there is no honest two-step policy — and a
    // one-step policy would silently deploy half of what was drawn.
    const mapping = reduceChainToLivePolicy(vaultChain({ amount: "" }), FIXTURE_ADAPTERS);
    expect(mapping.deployable).toBe(false);
  });

  describe("the deploy handoff never offers more than the app page can sign", () => {
    it("refuses a multi-step design and repeats the stranding notice verbatim", () => {
      const policy = reduceChainToLivePolicy(vaultChain(), FIXTURE_ADAPTERS);
      const route = reduceChainToLiveRoute(vaultChain(), FIXTURE_ADAPTERS);
      expect(policy.deployable).toBe(true);
      // The capsule can carry it; `/app` builds one-step policies with
      // `buildRobinhoodPolicy`, so the CTA must not appear. An enabled Deploy
      // that creates a different capsule from the one on the canvas is the
      // same broken promise as an unenforced guard.
      expect(route.deployable).toBe(false);
      if (route.deployable || !policy.deployable) return;

      expect(route.reasons[0]).toContain("2-step capsule");
      expect(route.reasons[0]).toContain("signs single-step capsules only");
      expect(route.reasons[0]).toContain("Step 2 (Supply)");
      // Being rejected is not a reason to drop what the design would have done.
      expect(route.reasons.slice(1)).toEqual(policy.notices);
    });

    it("carries every policy notice into the array the CTA renders word for word", () => {
      // Single-step policies have no notices today, so this pins the wiring
      // rather than a value: whatever a future rule adds to `notices` reaches
      // the list the deploy CTA prints, instead of stopping at a layer nobody
      // renders.
      const policy = reduceChainToLivePolicy(buyChain());
      const route = reduceChainToLiveRoute(buyChain());
      if (!policy.deployable || !route.deployable) throw new Error("the live route must deploy");
      expect(route.unenforcedGuards).toEqual([...policy.notices, ...policy.unenforcedGuards]);
    });

    it("never offers a route the policy layer rejected, or one the compiler blocks", () => {
      const designs: ChainNode[][] = [
        buyChain(),
        vaultChain(),
        vaultChain({ amount: "" }),
        chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ["supply", { market: "ZapVault", amount: "1" }]),
        chain(["swap", { into: "0xZAPS", venue: "Uniswap v4" }], ["wallet-balance", { asset: "WETH", amount: "0.05" }]),
        chain(["wallet-balance", { asset: "WETH", amount: "0.05" }], ["loop", { runs: 12 }]),
        [],
      ];
      for (const adapters of [undefined, FIXTURE_ADAPTERS]) {
        for (const design of designs) {
          const shape = design.map((node) => node.blockId).join(" -> ") || "<empty>";
          const policy = reduceChainToLivePolicy(design, adapters);
          const route = reduceChainToLiveRoute(design, adapters);
          if (route.deployable) {
            expect(policy.deployable, `route deployable but policy is not: ${shape}`).toBe(true);
            expect(policy.deployable && policy.steps.length, shape).toBe(1);
          }
          // And the invariant the whole module rests on: a deployable design is
          // never one the compiler calls broken.
          if (policy.deployable) {
            expect(compileChain(design).status, `deployable but status=block: ${shape}`).not.toBe("block");
          }
        }
      }
    });
  });
});
