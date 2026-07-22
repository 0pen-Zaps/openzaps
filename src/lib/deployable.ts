import { compileChain, getBlock, resolveSlippageGuards, type ChainNode, type LegoBlock } from "@/lib/blocks";
import { parseRouterAmount, type ZapDirection } from "@/lib/openzap";

/**
 * The bridge between the visual builder and what Robinhood Chain will actually
 * accept.
 *
 * The builder is a design surface: it can express borrows, bridges, loops, and
 * cadences. The deployed v1.1 contracts implement exactly one bounded route — a
 * single-step aeWETH <-> 0xZAPS swap through one adapter, recipient forced to
 * the owner, `maxRelayerFeeCap` 0, `optimization` true. This module is the only
 * place that decides whether a design reduces to that route, and it is
 * deliberately strict: everything it cannot map is rejected by name rather than
 * quietly approximated.
 */

/** Mirrors the signed-slippage control on the live app page (10–500 bps). */
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
/**
 * That control also steps in tens, while the builder's guard steps in fives, so
 * half the caps a design can express are not values the app can sign. Rounding
 * here — and saying so — is what keeps the handoff honest: the alternative is
 * telling someone their 75 bps cap was carried over while the slider they land
 * on cannot hold 75.
 */
export const SLIPPAGE_STEP_BPS = 10;
/** What the live app signs when a design never states a slippage cap. */
export const DEFAULT_SLIPPAGE_BPS = 100;

export type LiveRouteMapping =
  | { deployable: true; direction: ZapDirection; amountIn: string; slippageBps: number; unenforcedGuards: string[] }
  | { deployable: false; reasons: string[] };

type Placed = { node: ChainNode; block: LegoBlock };

/**
 * Why a source other than a wallet balance cannot open a live route.
 *
 * Named individually because "unsupported source" tells a user nothing about
 * which part of their design is the impossible part.
 */
const SOURCE_REJECTIONS: Record<string, string> = {
  "recurring-stream":
    "Recurring deposit sets a cadence, and a cadence is not expressible in the live policy: the v1.1 capsule holds one signed step that executes once, not a schedule. Nothing onchain would repeat it.",
  "pending-rewards":
    "Pending rewards emits a claimable, not tokens. The live route can only spend an ERC-20 amount pulled from the owner wallet, so there is nothing for it to swap.",
};

const SINK_REJECTIONS: Record<string, string> = {
  hold: "Hold in zap cannot be deployed: the live policy forces recipient = owner wallet, so the swap output always leaves the capsule.",
  "hold-lp":
    "Hold position cannot be deployed: the live route ends on an ERC-20 balance sent to the owner wallet, never on an open liquidity position.",
  loop: "Loop back cannot be deployed: the live policy is a single signed step with no compounding — it executes once and settles.",
};

/**
 * Guards the design states that the v1.1 policy does NOT bind onchain, and the
 * verbatim sentence the UI should show for each.
 *
 * THIS IS THE MOST IMPORTANT THING IN THIS FILE. Every one of these blocks
 * reads, in the builder, like a safety property the user is buying. None of
 * them survive into the deployed policy. Deploying a design while silently
 * dropping a guard the user placed is the worst failure this product can
 * commit: it would leave someone believing an oracle band, an expiry, or a
 * per-run approval is protecting funds that nothing is protecting. So every
 * such guard is surfaced, by name, with what is actually missing — and if a
 * guard is ever genuinely bound by a future policy version, it must be removed
 * from this map in the same change that binds it, never before.
 */
function unenforcedGuardNote(block: LegoBlock, node: ChainNode): string | null {
  switch (block.id) {
    case "guard-oracle":
      return `Price band (±${node.params.band ?? "?"}%) is designed but not enforced: the v1.1 policy has no oracle precondition, so nothing checks the band before execution.`;
    case "guard-window":
      return `Time window (${node.params.expiry ?? "?"}) is designed but not enforced: the v1.1 policy has no expiry or cadence field. The capsule stays executable until you withdraw or recover it.`;
    case "guard-private":
      return "Private submission is designed but not enforced: the v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the mempool path.";
    case "guard-approval":
      return "Human gate is designed but not enforced: the v1.1 policy has no per-run approval step. The signed policy is the only authority, bounded by its amount.";
    case "guard-spend":
      return `Spend ceiling (${node.params.cap ?? "?"}) is designed but not enforced: the v1.1 policy tracks no cumulative budget. The only onchain bound is the single step amount you sign.`;
    default:
      return null;
  }
}

/**
 * Reduce a builder chain to the one route the live contracts implement.
 *
 * Every reason is collected rather than short-circuiting on the first: a user
 * fixing a design needs the whole list, not one problem at a time.
 */
export function reduceChainToLiveRoute(chain: readonly ChainNode[]): LiveRouteMapping {
  const reasons: string[] = [];
  const unenforcedGuards: string[] = [];

  const known: Placed[] = [];
  for (const node of chain) {
    const block = getBlock(node.blockId);
    if (!block) {
      reasons.push(`This design references "${node.blockId}", which is not a block this build ships.`);
      continue;
    }
    known.push({ node, block });
  }

  // ---- source: exactly one, and it must be the wallet pull -----------------
  const sources = known.filter((entry) => entry.block.kind === "source");
  let source: Placed | null = null;
  if (sources.length === 0) {
    reasons.push("A live route starts from exactly one wallet balance; this design has no source.");
  } else if (sources.length > 1) {
    reasons.push(
      `A live route draws from exactly one source; this design has ${sources.length} (${nameList(sources)}).`,
    );
  }
  for (const entry of sources) {
    if (entry.block.id === "wallet-balance") {
      source ??= entry;
      continue;
    }
    reasons.push(
      SOURCE_REJECTIONS[entry.block.id] ??
        `${entry.block.name} cannot open a live route: the v1.1 capsule pulls a fixed ERC-20 amount from the owner wallet and nothing else.`,
    );
  }

  // ---- action: exactly one, and it must be the Uniswap v4 swap ------------
  const actions = known.filter((entry) => entry.block.kind === "action");
  let swap: Placed | null = null;
  if (actions.length === 0) {
    reasons.push("A live route is exactly one swap; this design has no action to deploy.");
  } else if (actions.length > 1) {
    reasons.push(
      `The live contracts execute exactly one step; this design has ${actions.length} actions (${nameList(actions)}). Multi-step chains cannot be deployed.`,
    );
  }
  for (const entry of actions) {
    if (entry.block.id === "swap") {
      swap ??= entry;
      continue;
    }
    reasons.push(
      `${entry.block.name} has no adapter on the live route — the only step the v1.1 capsule can execute is a single aeWETH ↔ 0xZAPS swap.`,
    );
  }
  if (swap) {
    const venue = String(swap.node.params.venue ?? "");
    if (venue !== "Uniswap v4") {
      reasons.push(
        `The live adapter routes through Uniswap v4; this swap names ${venue ? `${venue}, which has no adapter here` : "no venue"}.`,
      );
    }
  }

  // ---- direction: the pair is the route, and there is only one pair -------
  let direction: ZapDirection | null = null;
  if (source && swap) {
    const from = String(source.node.params.asset ?? "");
    const into = String(swap.node.params.into ?? "");
    if (from === "WETH" && into === "0xZAPS") direction = "buy";
    else if (from === "0xZAPS" && into === "WETH") direction = "sell";
    else {
      reasons.push(
        `The live route only swaps aeWETH ↔ 0xZAPS. This design swaps ${from || "an unnamed asset"} into ${into || "an unnamed asset"}.`,
      );
    }
  }

  // ---- sink: absent, or a send back to the owner --------------------------
  const sinks = known.filter((entry) => entry.block.kind === "sink");
  if (sinks.length > 1) {
    reasons.push(`A live route settles once; this design has ${sinks.length} settlement blocks (${nameList(sinks)}).`);
  }
  for (const entry of sinks) {
    if (entry.block.id === "send") {
      const recipient = String(entry.node.params.recipient ?? "");
      if (recipient !== "owner wallet") {
        reasons.push(
          "Send to recipient uses a custom address, but the live policy hardcodes recipient = owner wallet. A capsule that settles anywhere else is not deployable here.",
        );
      }
      continue;
    }
    reasons.push(
      SINK_REJECTIONS[entry.block.id] ??
        `${entry.block.name} cannot settle a live route: the v1.1 policy always sends the swap output to the owner wallet.`,
    );
  }

  // ---- amount: the router's own parser is the authority -------------------
  let amountIn: string | null = null;
  if (source) {
    const raw = String(source.node.params.amount ?? "").trim();
    try {
      parseRouterAmount(raw);
      amountIn = raw;
    } catch (error) {
      reasons.push(
        `Wallet balance amount ${raw ? `"${raw}"` : "is empty and"} cannot be deployed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---- guards: bind what we can, name what we cannot ----------------------
  const noted = new Set<string>();
  for (const { node, block } of known) {
    // Slippage is resolved across the whole chain below, not per placement:
    // deciding it here would let whichever cap came last overwrite the rest.
    if (block.kind !== "guard" || block.id === "guard-slippage") continue;

    const note = unenforcedGuardNote(block, node);
    if (note && !noted.has(block.id)) {
      noted.add(block.id);
      unenforcedGuards.push(note);
    }
  }

  // ---- slippage: the tightest cap governs, and every drop is disclosed -----
  const slippage = resolveSlippageGuards(chain);
  for (const raw of slippage.invalid) {
    reasons.push(`Slippage cap "${raw}" is not a number of basis points.`);
  }

  const slippageNotes: string[] = [];
  let slippageBps = DEFAULT_SLIPPAGE_BPS;
  if (slippage.governingBps !== null) {
    const governing = slippage.governingBps;
    const stepped = Math.round(governing / SLIPPAGE_STEP_BPS) * SLIPPAGE_STEP_BPS;
    slippageBps = Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, stepped));

    // A design can carry several caps, and only one number reaches the app. The
    // looser ones bind nothing, which is exactly the kind of silent drop the
    // list below exists to prevent — so it is stated with the count and the
    // values, not merely implied by the number in the CTA.
    if (slippage.caps.length > 1) {
      const dropped = slippage.caps.length - 1;
      slippageNotes.push(
        `Slippage cap: ${slippage.caps.length} caps are placed in this design (${slippage.caps
          .map((cap) => `${cap} bps`)
          .join(", ")}). Only the tightest governs, so this deploys with ${slippageBps} bps and the ${
          dropped === 1 ? "other cap is" : `other ${dropped} caps are`
        } not enforced.`,
      );
    }

    // Derived once, from the value that actually gets signed. Reporting a
    // per-block rounding as it happens would let the disclosure name a number
    // no one ends up deploying.
    if (slippageBps !== governing) {
      const why =
        governing < MIN_SLIPPAGE_BPS || governing > MAX_SLIPPAGE_BPS
          ? `is outside the range the live app signs (${MIN_SLIPPAGE_BPS}–${MAX_SLIPPAGE_BPS} bps)`
          : `is not one of the caps the live app can sign (it steps in ${SLIPPAGE_STEP_BPS} bps)`;
      slippageNotes.push(`Slippage cap: ${governing} bps ${why}, so it will be deployed as ${slippageBps} bps.`);
    }
  }

  // ---- structure: kind counts are not connectivity ------------------------
  // Everything above counts blocks by kind and ignores the order they sit in.
  // `compileChain` is the only thing that knows whether they seat: a shared
  // `?d=` link can encode [swap, wallet-balance], which has exactly one source
  // and exactly one swap and would otherwise be offered a Deploy button beside
  // a readout reading "Will not compile". Only the structural codes are
  // forwarded — unknown ids and source counts are already rejected above, in
  // wording that names the live route.
  for (const issue of compileChain(chain).issues) {
    if (issue.level !== "block") continue;
    if (issue.code !== "orphan" && issue.code !== "mismatch") continue;
    reasons.push(`This design does not compile, so it cannot be deployed: ${issue.message}`);
  }

  if (reasons.length > 0 || !source || !swap || direction === null || amountIn === null) {
    return {
      deployable: false,
      reasons: reasons.length > 0 ? reasons : ["This design does not reduce to the live aeWETH ↔ 0xZAPS route."],
    };
  }

  // Slippage first: it qualifies the very number the CTA above it promises,
  // and the rest of the list is in the order the guards were stacked.
  return { deployable: true, direction, amountIn, slippageBps, unenforcedGuards: [...slippageNotes, ...unenforcedGuards] };
}

function nameList(entries: readonly Placed[]): string {
  return entries.map((entry) => entry.block.name).join(", ");
}
