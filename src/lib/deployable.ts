import { compileChain, getBlock, resolveSlippageGuards, type ChainNode, type LegoBlock } from "@/lib/blocks";
import {
  MAX_POLICY_STEPS,
  ROBINHOOD_ADAPTERS,
  adapterSpecsForBlock,
  deployedAdapters,
  findDeployedAdapter,
  matchingAdapterSpecs,
  onlyBoundedSwapIsDeployed,
  type AdapterKind,
  type AdapterSet,
  type AdapterSpec,
} from "@/lib/chains";
import { parseRouterAmount, type ZapDirection } from "@/lib/openzap";

/**
 * The bridge between the visual builder and what Robinhood Chain will actually
 * accept.
 *
 * The builder is a design surface: it can express borrows, bridges, loops, and
 * cadences. The capsule holds up to sixteen steps, but a step is only real if
 * an adapter for it is deployed AND allowlisted — so what this module will
 * offer is decided entirely by `chains.ts`, the registry of adapters that
 * exist. With nothing new configured, that set is one bounded aeWETH ↔ 0xZAPS
 * swap, which is why the reductions below still collapse to the single route
 * the live app signs.
 *
 * Two layers, because "what the contracts can carry" and "what the app page
 * can sign" are different questions and answering them with one function is
 * how a Deploy button ends up promising a capsule nobody can create:
 *
 *   `reduceChainToLivePolicy` — the general reduction. Emits a multi-step
 *   policy when the adapters for those steps are deployed.
 *
 *   `reduceChainToLiveRoute`  — the deploy handoff. `/app` builds its policy
 *   with `buildRobinhoodPolicy`, which emits exactly ONE step through the
 *   bounded swap, so this narrows the policy to that shape and rejects
 *   anything else by name. It never widens what the CTA offers on its own.
 *
 * Everything either layer cannot map is rejected by name rather than quietly
 * approximated.
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

/** One step of an emitted policy, with the adapter that will execute it. */
export type LiveStep = {
  /** 1-based position in the policy the capsule will walk. */
  position: number;
  /** The placement this step came from, so the UI can point at the card. */
  uid: string;
  blockId: string;
  /** The block's name, for copy that has to name the step. */
  label: string;
  adapterId: string;
  adapterAddress: string;
  kind: AdapterKind;
  tokenIn: string;
  tokenOut: string;
  /**
   * FROZEN AT SIGNING. `Step.amountIn` is a constant in the policy hash, not a
   * reference to whatever the step above produced — see the stranding notices.
   * Kept as the decimal string the design stated, so it reaches
   * `parseRouterAmount` without a float in the middle.
   */
  amountIn: string;
  /** Which side of the bounded pair a swap step is; `null` for anything else. */
  direction: ZapDirection | null;
};

export type LivePolicyMapping =
  | {
      deployable: true;
      /** In execution order, one per action block. Never empty. */
      steps: LiveStep[];
      /** The single ERC-20 the capsule settles in: the last step's output. */
      outAsset: string;
      /** Step 1's amount — the pull the owner funds and signs. */
      amountIn: string;
      slippageBps: number;
      /**
       * The direction `/app` would sign, or `null` when this policy is not a
       * single bounded swap and therefore has no such thing.
       */
      direction: ZapDirection | null;
      /**
       * Facts about this policy that the UI must render WORD FOR WORD: which
       * step's surplus strands, and what it takes to get it back. Empty for a
       * single-step policy, which has no such boundary.
       */
      notices: string[];
      /** Guards the design states that the deployed policy does not bind. */
      unenforcedGuards: string[];
    }
  | { deployable: false; reasons: string[] };

export type LiveRouteMapping =
  | {
      deployable: true;
      /**
       * The deployed route `/app` will sign — a `chains.ts` adapter id. This is
       * the route identity the handoff carries; `direction` is a legacy hint
       * that is non-null ONLY for the bounded aeWETH↔0xZAPS pair, because a
       * buy/sell bit is ambiguous once a second pool shares an input token.
       */
      routeId: string;
      direction: ZapDirection | null;
      amountIn: string;
      slippageBps: number;
      unenforcedGuards: string[];
    }
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
 * Reduce a builder chain to a policy the deployed adapters can execute.
 *
 * Every reason is collected rather than short-circuiting on the first: a user
 * fixing a design needs the whole list, not one problem at a time.
 */
export function reduceChainToLivePolicy(
  chain: readonly ChainNode[],
  adapters: AdapterSet = ROBINHOOD_ADAPTERS,
): LivePolicyMapping {
  const reasons: string[] = [];
  const unenforcedGuards: string[] = [];

  // Read once per call, never cached across calls: an env change must not need
  // a reload to be believed, and the whole point of the registry is that this
  // function has no opinion of its own about what exists.
  const boundedOnly = onlyBoundedSwapIsDeployed(undefined, adapters);

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

  // ---- amount: the router's own parser is the authority -------------------
  // Resolved before the steps because step 1 spends exactly this.
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

  // ---- actions: one policy step each, and every one needs an adapter ------
  const actions = known.filter((entry) => entry.block.kind === "action");
  const stepBudget = boundedOnly ? 1 : MAX_POLICY_STEPS;
  if (actions.length === 0) {
    reasons.push(
      boundedOnly
        ? "A live route is exactly one swap; this design has no action to deploy."
        : "A deployable policy needs at least one action; this design has none.",
    );
  } else if (actions.length > stepBudget) {
    reasons.push(
      boundedOnly
        ? // Not a limit of the capsule — it walks sixteen steps — but of the
          // deployed set: one adapter, welded to one pool. A second step could
          // only be a second pass through that pool, which settles in the
          // asset it spends and reverts on the balance-delta check.
          `This build deploys exactly one step; this design has ${actions.length} actions (${nameList(actions)}). One adapter is deployed on Robinhood Chain and it is welded to one pool, so there is nothing to execute a second step.`
        : `The capsule walks at most ${MAX_POLICY_STEPS} steps; this design has ${actions.length} actions (${nameList(actions)}).`,
    );
  }

  const steps: LiveStep[] = [];
  // The asset flowing into the next step. `null` once it is unknowable — no
  // source, or a step above that did not resolve.
  let carried: string | null = source ? String(source.node.params.asset ?? "") : null;
  for (const [index, entry] of actions.entries()) {
    const position = index + 1;

    // Whether an adapter for this block exists at all, and whether the venue
    // it names has one, do not depend on what flows in. Both are reported for
    // every action in the design, including actions below a step that already
    // failed: a user fixing a chain should see every block that has no route,
    // not just the topmost one.
    const blockLevel = blockLevelRejection(entry, boundedOnly, adapters);
    if (blockLevel) {
      reasons.push(blockLevel);
      carried = null;
      continue;
    }

    // Anything past here reads the asset flowing in, so with that unknown the
    // step is skipped SILENTLY — a rejection derived from an asset nobody knows
    // would be noise stacked on the real reason above it.
    if (carried === null) continue;

    const stepAmount = position === 1 ? amountIn : String(entry.node.params.amount ?? "").trim();
    const resolved = resolveStep(entry, position, carried, stepAmount, boundedOnly, adapters);
    if (!resolved.ok) {
      reasons.push(...resolved.reasons);
      carried = null;
      continue;
    }
    steps.push(resolved.step);
    carried = resolved.step.tokenOut;
  }

  // ---- settlement: ONE asset has to end up higher -------------------------
  // `OpenZap.execute()` reads `balanceOf(outAsset)` before the loop and
  // subtracts it after, so a policy that spends the very asset it settles in
  // underflow-reverts unless the round trip came back profitable. A builder
  // that offered that shape would be selling a coin flip as a zap.
  if (steps.length > 0 && steps.length === actions.length) {
    const outAsset = steps[steps.length - 1].tokenOut;
    const spender = steps.find((step) => step.tokenIn === outAsset);
    if (spender) {
      reasons.push(
        `Step ${spender.position} (${spender.label}) spends ${outAsset}, and ${outAsset} is also what this design settles in. The capsule measures its ${outAsset} balance before the first step and requires a higher one after the last, so a policy that spends its own output asset reverts unless the round trip comes back profitable. This build will not sign that for you.`,
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

  if (reasons.length > 0 || !source || amountIn === null || steps.length === 0 || steps.length !== actions.length) {
    return {
      deployable: false,
      reasons: reasons.length > 0 ? reasons : ["This design does not reduce to the live aeWETH ↔ 0xZAPS route."],
    };
  }

  return {
    deployable: true,
    steps,
    outAsset: steps[steps.length - 1].tokenOut,
    amountIn: steps[0].amountIn,
    slippageBps,
    // Only a lone bounded swap has a direction the app page can sign; a
    // multi-step policy has no single one, and saying "buy" about it would be
    // describing a fraction of what gets signed.
    direction: steps.length === 1 ? steps[0].direction : null,
    notices: strandingNotices(steps),
    // Slippage first: it qualifies the very number the CTA above it promises,
    // and the rest of the list is in the order the guards were stacked.
    unenforcedGuards: [...slippageNotes, ...unenforcedGuards],
  };
}

/**
 * Why this action can never be a step, whatever flows into it.
 *
 * Split out from the rest of the resolution because these two facts — nothing
 * deployed executes this block, and this swap names a venue with no adapter —
 * are true of the placement alone. They are reported even when the asset
 * reaching the block is unknown.
 */
function blockLevelRejection(entry: Placed, boundedOnly: boolean, adapters: AdapterSet): string | null {
  const { node, block } = entry;

  // While the bounded swap is the whole deployed set, every other action has
  // no adapter, full stop — and says so in one sentence rather than reporting
  // a token or weld mismatch against a contract that does not exist yet.
  if (boundedOnly && block.id !== "swap") return noAdapterReason(block, true, adapters);
  if (adapterSpecsForBlock(block.id, undefined, adapters).length === 0) {
    return noAdapterReason(block, boundedOnly, adapters);
  }

  // A swap names its venue, and the venue is the adapter. Checked before the
  // pair so that a design asking for Aerodrome is told about Aerodrome rather
  // than about a token pair it never got as far as.
  if (block.id === "swap") {
    const venue = String(node.params.venue ?? "");
    if (venue !== "Uniswap v4") {
      return `The live adapter routes through Uniswap v4; this swap names ${venue ? `${venue}, which has no adapter here` : "no venue"}.`;
    }
  }

  return null;
}

type StepResolution = { ok: true; step: LiveStep } | { ok: false; reasons: string[] };

/**
 * Turn one action block into a policy step, or say why it cannot be one.
 *
 * The rejection copy distinguishes three different facts, because they call for
 * three different things from the user: no deployed adapter takes what this
 * step is handed, an adapter that fits exists but is not deployed, and the
 * step names no amount of its own.
 *
 * Callers run `blockLevelRejection` first; by the time this is reached the
 * block has an adapter in the registry and, if it is a swap, a venue with one.
 */
function resolveStep(
  entry: Placed,
  position: number,
  tokenIn: string,
  amountIn: string | null,
  boundedOnly: boolean,
  adapters: AdapterSet,
): StepResolution {
  const { node, block } = entry;
  const candidates = adapterSpecsForBlock(block.id, undefined, adapters);
  const tokenOut = block.id === "swap" ? String(node.params.into ?? "") : undefined;
  const query = { blockId: block.id, tokenIn, tokenOut, params: node.params };
  const fitting = matchingAdapterSpecs(query, adapters);
  if (fitting.length === 0) {
    return { ok: false, reasons: [weldReason(block, candidates, tokenIn, tokenOut, node.params)] };
  }

  const adapter = findDeployedAdapter(query, adapters);
  if (!adapter) {
    return { ok: false, reasons: [notDeployedReason(block, fitting, boundedOnly)] };
  }

  // `Step.amountIn` is a constant in the signed policy. A step therefore cannot
  // spend "whatever the step above produced" — that quantity does not exist at
  // signing time — so every step has to name its own figure, and a design that
  // does not is rejected rather than given a guess.
  if (amountIn === null || amountIn.length === 0) {
    // Step 1 spends the wallet pull, whose amount is validated at the source.
    // Reaching here with position 1 means that validation already failed and
    // already produced a reason; adding a second one would double-report it.
    if (position === 1) return { ok: false, reasons: [] };
    return {
      ok: false,
      reasons: [
        `${block.name} is step ${position} of this design and states no amount of its own. Step.amountIn is frozen into the policy when you sign it, so a step cannot spend what the step above it produced — every step has to name the exact quantity it will pull. This design cannot be deployed until step ${position} names one.`,
      ],
    };
  }
  if (position > 1) {
    try {
      parseRouterAmount(amountIn);
    } catch (error) {
      return {
        ok: false,
        reasons: [
          `${block.name} is step ${position} and its amount "${amountIn}" cannot be deployed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  return {
    ok: true,
    step: {
      position,
      uid: node.uid,
      blockId: block.id,
      label: block.name,
      adapterId: adapter.id,
      adapterAddress: adapter.address,
      kind: adapter.kind,
      tokenIn: adapter.tokenIn,
      tokenOut: adapter.tokenOut,
      amountIn,
      direction: adapter.direction,
    },
  };
}

/** Nothing in the registry does this at all. */
function noAdapterReason(block: LegoBlock, boundedOnly: boolean, adapters: AdapterSet): string {
  if (boundedOnly) {
    return `${block.name} has no adapter on the live route — the only step the v1.1 capsule can execute is a single aeWETH ↔ 0xZAPS swap.`;
  }
  // Only adapters a drawn chain can actually reach. An entry whose `blockId` is
  // null is deployed but unreachable — no catalog block produces that step — so
  // listing it would answer "what can I build instead?" with something the user
  // cannot build. That is the exact failure this module exists to prevent.
  const live = deployedAdapters(undefined, adapters)
    .filter((adapter) => adapter.blockId !== null)
    .map((adapter) => adapter.label)
    .join(", ");
  if (!live) {
    return `${block.name} has no adapter on the live route, and no other step this build deploys can be drawn in the builder either.`;
  }
  return `${block.name} has no adapter on the live route. The steps this build can deploy are: ${live}.`;
}

/**
 * An adapter for this block exists, but not one that fits what was drawn.
 *
 * Two different mistakes, said differently, because they are fixed
 * differently: the step is handed an asset no adapter takes, or the step names
 * a protocol the deployed adapter is not welded to. The second is the one that
 * matters most — an adapter's protocol address is an immutable constructor
 * arg, so "supply into Morpho" can never be quietly satisfied by an adapter
 * pointed at something else.
 */
function weldReason(
  block: LegoBlock,
  candidates: readonly AdapterSpec[],
  tokenIn: string,
  tokenOut: string | undefined,
  params: Readonly<Record<string, unknown>>,
): string {
  if (block.id === "swap") {
    // Kept verbatim from the one-route era: it is the sentence someone reads
    // when they draw the wrong pair, and it names both sides of what they drew.
    return `The live route only swaps aeWETH ↔ 0xZAPS. This design swaps ${tokenIn || "an unnamed asset"} into ${tokenOut || "an unnamed asset"}.`;
  }

  const takesThisAsset = candidates.filter((spec) => spec.tokenIn === tokenIn);
  if (takesThisAsset.length > 0) {
    const spec = takesThisAsset[0];
    const named = Object.keys(spec.weldedParams)
      .map((key) => `${key} ${String(params[key] ?? "nothing")}`)
      .join(", ");
    return `${block.name} names ${named}, and the only adapter this build has for that step is ${spec.label}${describeWeld(spec)}. An adapter's protocol address is fixed when it is deployed, so it cannot be pointed at something else.`;
  }

  const welds = candidates.map((spec) => `${spec.label} (takes ${spec.tokenIn}${describeWeld(spec)})`).join(", ");
  return `${block.name} is handed ${tokenIn || "an unnamed asset"}, and no adapter here takes that. What this build knows for this step: ${welds}.`;
}

/** The right adapter exists in the registry and has no address configured. */
function notDeployedReason(block: LegoBlock, fitting: readonly AdapterSpec[], boundedOnly: boolean): string {
  if (boundedOnly) {
    // Same sentence as "no adapter at all" while the bounded swap is the whole
    // deployed set. Naming an env var would read as a promise that setting it
    // is all that stands between this design and a live capsule — the contract
    // still has to be deployed and allowlisted first.
    return `${block.name} has no adapter on the live route — the only step the v1.1 capsule can execute is a single aeWETH ↔ 0xZAPS swap.`;
  }
  const spec = fitting[0];
  return `${block.name} matches ${spec.label}, and that adapter is not deployed: no address is configured for it (${spec.envVar}), so nothing onchain can execute this step.`;
}

function describeWeld(spec: AdapterSpec): string {
  const welds = Object.entries(spec.weldedParams).map(([key, value]) => `${key} ${value}`);
  return welds.length ? `, welded to ${welds.join(", ")}` : "";
}

/**
 * The frozen-amount disclosure, one sentence per step boundary.
 *
 * This is the fact a multi-step design most needs told and is least likely to
 * guess. `Step.amountIn` is a constant in the policy hash: step 2 spends the
 * figure that was signed, NOT what step 1 produced. So a swap that returns more
 * than step 2 names leaves the difference sitting in the capsule — recoverable
 * only by the owner's exit — and one that returns less reverts the whole zap.
 * A user who signs a chain that strands most of a swap and was not told is the
 * failure this product must not commit, so this is rendered word for word.
 */
function strandingNotices(steps: readonly LiveStep[]): string[] {
  const notices: string[] = [];
  for (const step of steps) {
    if (step.position === 1) continue;
    const previous = steps[step.position - 2];
    notices.push(
      `Step ${step.position} (${step.label}) spends exactly ${step.amountIn} ${step.tokenIn}, because Step.amountIn is frozen into the policy when you sign it. Step ${previous.position} (${previous.label}) produces an amount nobody can know at signing time, so anything it produces above ${step.amountIn} ${step.tokenIn} stays in the capsule after the zap settles — recovering it takes the owner's emergency exit, nothing sweeps it back automatically — and if it produces less than ${step.amountIn} ${step.tokenIn}, the whole zap reverts.`,
    );
  }
  return notices;
}

/**
 * Reduce a builder chain to the one deployed route the deploy handoff can sign.
 *
 * `/app` signs SINGLE-STEP capsules — one adapter call — resolved by route id.
 * So this accepts any single-step policy whose one step runs through a deployed
 * adapter (the bounded swap, the USDG pool, or a vault deposit) and hands `/app`
 * the `routeId` to sign. A MULTI-STEP capsule is still refused: `/app` has no
 * way to sign it, and an enabled CTA that creates a different capsule from the
 * one on the canvas is the same broken promise as an unenforced guard.
 *
 * The vault seeding gate is NOT applied here (this reducer is pure — no RPC):
 * `/app` reads `vault.totalSupply() > 0` on import and refuses an unseeded vault
 * route exactly as it refuses any invalid import.
 */
export function reduceChainToLiveRoute(
  chain: readonly ChainNode[],
  adapters: AdapterSet = ROBINHOOD_ADAPTERS,
): LiveRouteMapping {
  const policy = reduceChainToLivePolicy(chain, adapters);
  if (!policy.deployable) return { deployable: false, reasons: policy.reasons };

  if (policy.steps.length > 1) {
    const rest = policy.steps.slice(1);
    const named = rest.map((step) => `${step.position} (${step.label})`).join(", ");
    return {
      deployable: false,
      reasons: [
        `This design reduces to a ${policy.steps.length}-step capsule, and the deploy page signs single-step capsules only — one adapter call. ${rest.length === 1 ? "Step" : "Steps"} ${named} would have nowhere to be signed, so no Deploy button is offered rather than one that creates a capsule this design did not describe.`,
        ...policy.notices,
      ],
    };
  }

  const [step] = policy.steps;
  // This reducer cannot read the chain, so it cannot know if a vault is seeded.
  // A vault route deploys only while the vault holds shares; say so verbatim so
  // the CTA does not read as a promise the /app seed gate will then refuse.
  const seedNote =
    step.kind === "vault-deposit" || step.kind === "vault-redeem"
      ? [
          "This vault route deploys only while the vault is seeded (totalSupply > 0). An unseeded ERC-4626 is grief-able, so the live app refuses one — the capsule may not be creatable yet.",
        ]
      : [];
  return {
    deployable: true,
    // The route identity is the adapter id: `/app` resolves the pool/vault, the
    // tokens and their decimals, and the Step.data encoding from it — never from
    // `direction`, which is null for everything but the bounded pair.
    routeId: step.adapterId,
    direction: policy.direction,
    amountIn: policy.amountIn,
    slippageBps: policy.slippageBps,
    // Notices first, ahead of the guard disclosures, and concatenated rather
    // than dropped: this is the array the CTA renders verbatim, and anything
    // material about the policy has to reach it even if it arrives from a
    // later rule than the one this list was built for.
    unenforcedGuards: [...seedNote, ...policy.notices, ...policy.unenforcedGuards],
  };
}

function nameList(entries: readonly Placed[]): string {
  return entries.map((entry) => entry.block.name).join(", ");
}
