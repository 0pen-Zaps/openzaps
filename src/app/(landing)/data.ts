import {
  BLOCKS,
  RECIPES,
  SHAPE_COLOR,
  SHAPE_LABEL,
  compileChain,
  defaultParams,
  encodeChain,
  getBlock,
  makeNode,
  type BlockKind,
  type ChainNode,
  type FlowShape,
  type ZapRecipe,
} from "@/lib/blocks";
import {
  PROTOCOL_IDS,
  protocolName,
  protocolsForAction,
  protocolsForRouteKind,
  type ProtocolId,
  type ProtocolInfo,
} from "@/lib/protocols";
import { reduceChainToLiveRoute } from "@/lib/deployable";
import { ROBINHOOD_ADAPTERS, deployedAdapters } from "@/lib/chains";
import { MAX_EXECUTION_FEE_PER_GAS, MAX_EXECUTION_GAS } from "@/lib/openzap";

/**
 * Server-side derivations for the landing page.
 *
 * Everything rendered on the landing — cards, rails, counters, share links —
 * comes out of the same catalogs and compiler that power the builder. If a
 * recipe stops compiling or a route stops reducing to a deployable policy,
 * the landing page changes with it. Nothing here is hand-maintained copy.
 */

export type CardStep = {
  label: string;
  kind: "source" | "action" | "guard" | "sink";
  shape: FlowShape | null;
  protocols: ProtocolInfo[];
};

export type RecipeCard = {
  id: string;
  name: string;
  tagline: string;
  accentColor: string;
  outputLabel: string;
  steps: CardStep[];
  blockCount: number;
  gas: number;
  guardScore: number;
  status: "pass" | "warn" | "block";
  deployable: boolean;
  /** Opens the real builder pre-loaded with this exact chain. */
  builderHref: string;
  shareToken: string;
};

function chainFor(recipe: ZapRecipe): ChainNode[] {
  return recipe.blocks.map(([blockId, params], index) =>
    makeNode(blockId, `${recipe.id}-${index}`, params),
  );
}

export function recipeCard(recipe: ZapRecipe): RecipeCard {
  const chain = chainFor(recipe);
  const compiled = compileChain(chain);
  const live = reduceChainToLiveRoute(chain);
  const token = encodeChain(chain);
  const steps: CardStep[] = chain.map((node) => {
    const block = getBlock(node.blockId);
    return {
      label: block?.name ?? node.blockId,
      kind: block?.kind ?? "action",
      shape: block?.emits ?? block?.accepts ?? null,
      protocols: protocolsForAction(node.blockId, node.params),
    };
  });
  return {
    id: recipe.id,
    name: recipe.name,
    tagline: recipe.tagline,
    accentColor: SHAPE_COLOR[recipe.accent],
    // The recipe's editorial accent shape, not compileChain's outputShape:
    // finished chains end in sinks, which emit null.
    outputLabel: SHAPE_LABEL[recipe.accent],
    steps,
    blockCount: chain.length,
    gas: compiled.gas,
    guardScore: compiled.guardScore,
    status: compiled.status,
    deployable: live.deployable,
    builderHref: `/zap?d=${token}`,
    shareToken: token,
  };
}

const CARD_IDS = [
  "sell-zaps",
  "stitched-route",
  "provide-liquidity",
  "exit-liquidity",
  "live-route",
  "lp-autocompound",
] as const;

export function landingCards(): RecipeCard[] {
  return RECIPES.filter((recipe) => (CARD_IDS as readonly string[]).includes(recipe.id)).map(
    recipeCard,
  );
}

// The "Social Zaps" strip shows a representative set with live/design badges, so the copy's point
// ("if it reduces to a live route — signs and runs it") always has both to show. Curated by id, not
// a RECIPES prefix slice: a prefix slice silently changed membership the moment a blueprint was
// inserted, once dropping the only design example off the strip. Four deployable routes + one design.
const SHAREABLE_IDS = ["live-route", "sell-zaps", "stitched-route", "provide-liquidity", "dca"] as const;

export function shareableCards(): RecipeCard[] {
  return SHAREABLE_IDS.map((id) => RECIPES.find((recipe) => recipe.id === id))
    .filter((recipe): recipe is (typeof RECIPES)[number] => recipe !== undefined)
    .map(recipeCard);
}

/* ------------------------------------------------------------------ */
/* Route rail: the deployable recipes as node → protocol → node rails. */
/* ------------------------------------------------------------------ */

export type RailStop = {
  kind: "asset" | "hop";
  label: string;
  sublabel?: string;
  protocols?: ProtocolInfo[];
};

export type Rail = {
  id: string;
  name: string;
  intent: string;
  stops: RailStop[];
  gas: number;
  blockCount: number;
  manualActions: number;
  slippageBps: number | null;
};

/**
 * Hand-annotated presentation of the deployable recipes' real routes. The
 * stops narrate what the adapters actually do; gas/step counts still come
 * from the compiler so they cannot drift.
 */
const RAIL_PRESENTATION: Record<
  string,
  { intent: string; stops: RailStop[]; manualActions: number }
> = {
  "stitched-route": {
    intent: "Turn USDG into 0xZAPS",
    manualActions: 5,
    stops: [
      { kind: "asset", label: "USDG" },
      {
        kind: "hop",
        label: "Uniswap v4",
        sublabel: "aeWETH/USDG pool",
        protocols: [{ id: "uniswap-v4", name: protocolName("uniswap-v4") }],
      },
      { kind: "asset", label: "aeWETH" },
      {
        kind: "hop",
        label: "Uniswap v4",
        sublabel: "0xZAPS/aeWETH pool",
        protocols: [{ id: "uniswap-v4", name: protocolName("uniswap-v4") }],
      },
      { kind: "asset", label: "0xZAPS" },
      { kind: "hop", label: "send", sublabel: "owner wallet" },
      { kind: "asset", label: "Token exit" },
    ],
  },
  "provide-liquidity": {
    intent: "Turn aeWETH into a balanced LP position",
    manualActions: 6,
    stops: [
      { kind: "asset", label: "aeWETH" },
      {
        kind: "hop",
        label: "Uniswap v4",
        sublabel: "half swapped to USDG",
        protocols: [{ id: "uniswap-v4", name: protocolName("uniswap-v4") }],
      },
      { kind: "asset", label: "aeWETH + USDG" },
      {
        kind: "hop",
        label: "OpenZaps vault",
        sublabel: "full-range position",
        protocols: [{ id: "openzaps-vault", name: protocolName("openzaps-vault") }],
      },
      { kind: "asset", label: "ozRANGE" },
      { kind: "hop", label: "hold", sublabel: "shares to owner" },
      { kind: "asset", label: "LP position" },
    ],
  },
  "exit-liquidity": {
    intent: "Unwind an LP position into USDG",
    manualActions: 5,
    stops: [
      { kind: "asset", label: "ozRANGE" },
      {
        kind: "hop",
        label: "OpenZaps vault",
        sublabel: "burn shares",
        protocols: [{ id: "openzaps-vault", name: protocolName("openzaps-vault") }],
      },
      { kind: "asset", label: "aeWETH + USDG" },
      {
        kind: "hop",
        label: "Uniswap v4",
        sublabel: "aeWETH leg to USDG",
        protocols: [{ id: "uniswap-v4", name: protocolName("uniswap-v4") }],
      },
      { kind: "asset", label: "USDG" },
      { kind: "hop", label: "send", sublabel: "owner wallet" },
      { kind: "asset", label: "Stable exit" },
    ],
  },
};

export function landingRails(): Rail[] {
  return Object.entries(RAIL_PRESENTATION).map(([id, presentation]) => {
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe) throw new Error(`landing rail references unknown recipe ${id}`);
    const chain = chainFor(recipe);
    const compiled = compileChain(chain);
    const live = reduceChainToLiveRoute(chain);
    return {
      id,
      name: recipe.name,
      intent: presentation.intent,
      stops: presentation.stops,
      gas: compiled.gas,
      blockCount: chain.length,
      manualActions: presentation.manualActions,
      slippageBps: live.deployable ? live.slippageBps : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Hero assembly: one live recipe rendered as interlocking DeFi bricks. */
/* ------------------------------------------------------------------ */

export type AssemblyBrick = {
  key: string;
  blockId: string;
  label: string;
  detail: string;
  kind: BlockKind;
  glyph: string;
  protocols: ProtocolInfo[];
};

export type AssemblyPlan = {
  recipeId: string;
  title: string;
  result: string;
  deployable: boolean;
  bricks: AssemblyBrick[];
};

/**
 * Keep the hero honest by deriving it from the same live LP blueprint the
 * builder opens. The action brick carries both marks because that adapter
 * swaps in Uniswap v4 and then custodies the position in the OpenZaps range
 * vault; guards and settlement remain actions, not invented protocols.
 */
export function assemblyPlan(): AssemblyPlan {
  const recipe = RECIPES.find((candidate) => candidate.id === "provide-liquidity");
  if (!recipe) throw new Error("hero assembly references unknown recipe provide-liquidity");
  const chain = chainFor(recipe);
  const live = reduceChainToLiveRoute(chain);

  return {
    recipeId: recipe.id,
    title: recipe.name,
    result: "aeWETH → ozRANGE",
    deployable: live.deployable,
    bricks: chain.map((node) => {
      const block = getBlock(node.blockId);
      if (!block) throw new Error(`hero assembly references unknown block ${node.blockId}`);
      const details: Record<string, string> = {
        "wallet-balance": "fund with aeWETH",
        "guard-slippage": `${String(node.params.bps ?? 100)} bps maximum`,
        "add-liquidity": "Uniswap v4 + range vault",
        "hold-lp": "shares to owner",
      };
      return {
        key: node.uid,
        blockId: node.blockId,
        label: block.name,
        detail: details[node.blockId] ?? block.category,
        kind: block.kind,
        glyph: block.glyph,
        protocols: protocolsForAction(node.blockId, node.params),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Metrics: real counts out of the catalogs and the adapter registry.  */
/* ------------------------------------------------------------------ */

export type LandingMetrics = {
  blocks: number;
  blueprints: number;
  deployableBlueprints: number;
  adapters: number;
  routeKinds: number;
  maxCompression: { blocks: number; recipe: string };
};

/* ------------------------------------------------------------------ */
/* Protocol graph: nodes from the catalog, deployed truth from chains. */
/* ------------------------------------------------------------------ */

export type GraphNode = {
  id: ProtocolId;
  name: string;
  deployed: boolean;
  /** Catalog blocks that can route through this protocol. */
  actions: string[];
};

export type GraphEdge = { a: ProtocolId; b: ProtocolId; live: boolean };

export function protocolGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const deployed = new Set<ProtocolId>();
  for (const spec of deployedAdapters()) {
    for (const p of protocolsForRouteKind(spec.kind)) deployed.add(p.id);
  }

  const actions = new Map<ProtocolId, Set<string>>();
  const pairs = new Map<string, GraphEdge>();

  for (const block of BLOCKS) {
    // Enumerate every venue/market a select param can name, so a protocol's
    // action list reflects the whole catalog, not just defaults.
    const variants: Record<string, string | number>[] = [defaultParams(block)];
    for (const param of block.params) {
      if (param.type === "select") {
        for (const option of param.options) {
          variants.push({ ...defaultParams(block), [param.key]: option });
        }
      }
    }
    const touched = new Set<ProtocolId>();
    for (const params of variants) {
      for (const p of protocolsForAction(block.id, params)) touched.add(p.id);
    }
    for (const id of touched) {
      const set = actions.get(id) ?? new Set<string>();
      set.add(block.name);
      actions.set(id, set);
    }
    // A block that touches two protocols in one step is a composition edge.
    const base = protocolsForAction(block.id, defaultParams(block));
    if (base.length >= 2) {
      for (let i = 0; i < base.length; i += 1) {
        for (let j = i + 1; j < base.length; j += 1) {
          const key = [base[i].id, base[j].id].sort().join("+");
          pairs.set(key, {
            a: base[i].id,
            b: base[j].id,
            live: deployed.has(base[i].id) && deployed.has(base[j].id),
          });
        }
      }
    }
  }

  return {
    nodes: PROTOCOL_IDS.map((id) => ({
      id,
      name: protocolName(id),
      deployed: deployed.has(id),
      actions: [...(actions.get(id) ?? [])],
    })),
    edges: [...pairs.values()],
  };
}

/* ------------------------------------------------------------------ */
/* Agent plans: intent → bounded execution, from the adapter registry. */
/* ------------------------------------------------------------------ */

export type AgentPlan = {
  id: string;
  intent: string;
  route: string;
  adapterAddress: string;
  refuses: string;
  constraints: string[];
  checks: { label: string; detail: string; status: "pass" | "warn" | "block" }[];
};

const AGENT_INTENTS = [
  {
    recipeId: "live-route",
    adapterId: "robinhood-v4-weth-zaps",
    intent: "Zap in to 0xZAPS with 0.05 aeWETH",
  },
  {
    recipeId: "sell-zaps",
    adapterId: "robinhood-v4-zaps-weth",
    intent: "Zap 1,000,000 0xZAPS out to aeWETH",
  },
  {
    recipeId: "provide-liquidity",
    adapterId: "robinhood-range-deposit-weth",
    intent: "Provide aeWETH/USDG liquidity",
  },
  {
    recipeId: "exit-liquidity",
    adapterId: "robinhood-range-withdraw-usdg",
    intent: "Exit the LP position into USDG",
  },
] as const;

export function agentPlans(): AgentPlan[] {
  const adapters = deployedAdapters();
  return AGENT_INTENTS.map(({ recipeId, adapterId, intent }) => {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    const adapter = adapters.find((a) => a.id === adapterId);
    if (!recipe || !adapter) throw new Error(`agent plan references unknown ${recipeId}/${adapterId}`);
    const chain = chainFor(recipe);
    const compiled = compileChain(chain);
    const live = reduceChainToLiveRoute(chain);
    const constraints = [
      "Recipient is welded to the owner wallet at signing",
      live.deployable
        ? `Slippage capped at ${live.slippageBps} bps, signed into the execution intent's minimum-out`
        : "Slippage cap signed into the execution intent's minimum-out",
      "Amounts bounded to uint128 by the router",
      `Execution gas ceiling ${MAX_EXECUTION_GAS.toLocaleString("en-US")}`,
      `Execution gas price capped at ${Number(MAX_EXECUTION_FEE_PER_GAS / 1_000_000_000n)} gwei`,
    ];
    return {
      id: recipeId,
      intent,
      route: adapter.label,
      adapterAddress: adapter.address,
      refuses: adapter.refuses,
      constraints,
      checks: compiled.checks.map((c) => ({ label: c.label, detail: c.detail, status: c.status })),
    };
  });
}

export function landingMetrics(): LandingMetrics {
  const compiled = RECIPES.map((recipe) => ({
    recipe,
    chain: chainFor(recipe),
  }));
  const deployables = compiled.filter(({ chain }) => reduceChainToLiveRoute(chain).deployable);
  // The "N blocks → 1 signed step" pairing must only cite a blueprint that
  // genuinely reduces to one signed step today — not the deepest design in
  // the catalog.
  const biggest = deployables.reduce((a, b) => (b.chain.length > a.chain.length ? b : a));
  return {
    blocks: BLOCKS.length,
    blueprints: RECIPES.length,
    deployableBlueprints: deployables.length,
    // Registry rows are deliberately duplicated per (tokenIn, tokenOut)
    // direction; the honest "live" count is distinct deployed contracts.
    adapters: new Set(deployedAdapters().map((a) => a.address.toLowerCase())).size,
    routeKinds: new Set(ROBINHOOD_ADAPTERS.map((spec) => spec.kind)).size,
    maxCompression: { blocks: biggest.chain.length, recipe: biggest.recipe.name },
  };
}
