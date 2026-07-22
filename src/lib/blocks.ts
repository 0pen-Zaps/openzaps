import { policyHash, type SimulationCheck } from "@/lib/policy";

/**
 * The DeFi lego catalog behind the visual zap builder.
 *
 * A zap is a linear chain of blocks. Every block declares the *shape* of value
 * it consumes and the shape it produces, which is what makes the pieces behave
 * like physical lego: a stud only seats in a matching socket. The canvas never
 * has to special-case "can a swap follow a borrow" — it compares two shapes.
 */

/** The kind of value moving along a connector between two blocks. */
export type FlowShape = "token" | "lp" | "receipt" | "yield" | "debt";

/**
 * `source` opens a chain (emits, accepts nothing), `sink` closes it, `action`
 * transforms one shape into another, and `guard` is a passthrough constraint
 * that binds the policy without changing what flows.
 */
export type BlockKind = "source" | "action" | "guard" | "sink";

export type BlockCategory =
  | "source"
  | "swap"
  | "lend"
  | "liquidity"
  | "yield"
  | "bridge"
  | "guard"
  | "sink";

/** How far a block is from being safe to point at real funds. */
export type BlockMaturity = "live" | "preview" | "review" | "blocked";

/**
 * `amount` is deliberately a *string*, not a bounded number.
 *
 * Token amounts span eighteen decimals: a slider that steps in tens cannot
 * express 0.05 aeWETH, which is the size a real Robinhood Chain zap actually
 * carries. Keeping the raw decimal text also means the value can be handed to
 * `parseRouterAmount` unchanged, rather than round-tripped through a float that
 * loses wei on the way.
 */
export type BlockParam =
  | { key: string; label: string; type: "number"; value: number; min: number; max: number; step: number; suffix?: string }
  | { key: string; label: string; type: "select"; value: string; options: readonly string[] }
  | { key: string; label: string; type: "amount"; value: string; unit?: string; placeholder?: string }
  | { key: string; label: string; type: "text"; value: string; placeholder?: string };

export type ParamValue = string | number;

export type LegoBlock = {
  id: string;
  name: string;
  kind: BlockKind;
  category: BlockCategory;
  /** Palette one-liner. */
  blurb: string;
  /** Inspector copy: what this actually authorises onchain. */
  detail: string;
  /** Shape this block consumes; `null` for sources. */
  accepts: FlowShape | null;
  /** Shape this block produces; `null` for sinks. */
  emits: FlowShape | null;
  /** Icon key rendered by the builder's glyph component. */
  glyph: string;
  /** Rough execution cost in gas units, used for the chain estimate. */
  gas: number;
  maturity: BlockMaturity;
  params: readonly BlockParam[];
};

export const SHAPE_LABEL: Record<FlowShape, string> = {
  token: "ERC-20",
  lp: "LP position",
  receipt: "Vault share",
  yield: "Claimable",
  debt: "Debt line",
};

/** Connector colours double as the legend for the whole canvas. */
export const SHAPE_COLOR: Record<FlowShape, string> = {
  token: "#37f09a",
  lp: "#8ea0ff",
  receipt: "#6b5cff",
  yield: "#ffc26b",
  debt: "#ff7a90",
};

export const CATEGORY_LABEL: Record<BlockCategory, string> = {
  source: "Sources",
  swap: "Swap & route",
  lend: "Lend & borrow",
  liquidity: "Liquidity",
  yield: "Yield",
  bridge: "Bridge",
  guard: "Guards",
  sink: "Settlement",
};

export const BLOCKS: readonly LegoBlock[] = [
  // ---- sources -----------------------------------------------------------
  {
    id: "wallet-balance",
    name: "Wallet balance",
    kind: "source",
    category: "source",
    blurb: "Pull a fixed amount from the owner wallet.",
    detail:
      "A one-shot pull with an exact approval. The amount is bound into the policy hash, so the executor can never draw more than the figure you sign here. On Robinhood Chain the live route's WETH is aeWETH: picking WETH here means aeWETH there, and 0xZAPS is the only asset it pairs against.",
    accepts: null,
    emits: "token",
    glyph: "wallet",
    gas: 46_000,
    maturity: "live",
    params: [
      // "WETH" is the stored value on purpose: drafts, shared links, and tests
      // already serialise it, and the detail copy carries the aeWETH truth.
      { key: "asset", label: "Asset", type: "select", value: "WETH", options: ["USDC", "WETH", "cbBTC", "DAI", "0xZAPS"] },
      { key: "amount", label: "Amount", type: "amount", value: "0.05", placeholder: "0.05" },
    ],
  },
  {
    id: "recurring-stream",
    name: "Recurring deposit",
    kind: "source",
    category: "source",
    blurb: "Draw the same amount on a cadence.",
    detail:
      "The classic DCA source. Each execution draws one instalment; the spend ceiling guard is what stops the schedule from running away.",
    accepts: null,
    emits: "token",
    glyph: "repeat",
    gas: 52_000,
    maturity: "live",
    params: [
      { key: "asset", label: "Asset", type: "select", value: "USDC", options: ["USDC", "WETH", "cbBTC", "DAI"] },
      { key: "amount", label: "Per run", type: "amount", value: "100", placeholder: "100" },
      { key: "cadence", label: "Cadence", type: "select", value: "weekly", options: ["daily", "weekly", "monthly"] },
    ],
  },
  {
    id: "pending-rewards",
    name: "Pending rewards",
    kind: "source",
    category: "source",
    blurb: "Start from whatever has accrued.",
    detail:
      "Reads the claimable balance of an allowlisted reward source. Emits a claimable position rather than tokens — you still have to harvest it.",
    accepts: null,
    emits: "yield",
    glyph: "sparkle",
    gas: 38_000,
    maturity: "preview",
    params: [
      { key: "venue", label: "Source", type: "select", value: "Uniswap v4 fees", options: ["Uniswap v4 fees", "Gauge rewards", "Vault fees"] },
    ],
  },

  // ---- actions -----------------------------------------------------------
  {
    id: "swap",
    name: "Swap",
    kind: "action",
    category: "swap",
    blurb: "Exact-input swap through an allowlisted adapter.",
    detail:
      "Routes through a registered adapter with a bounded selector. The minimum-out is derived from your slippage guard and enforced as a postcondition.",
    accepts: "token",
    emits: "token",
    glyph: "swap",
    gas: 132_000,
    maturity: "live",
    params: [
      { key: "into", label: "Buy", type: "select", value: "WETH", options: ["USDC", "WETH", "cbBTC", "DAI", "0xZAPS"] },
      { key: "venue", label: "Venue", type: "select", value: "Uniswap v4", options: ["Uniswap v4", "Uniswap v3", "Aerodrome"] },
    ],
  },
  {
    id: "split",
    name: "Split",
    kind: "action",
    category: "swap",
    blurb: "Fan one balance into a weighted basket.",
    detail:
      "Divides the incoming balance by fixed weights before the next block. Weights are part of the signed policy, so the executor cannot re-cut them.",
    accepts: "token",
    emits: "token",
    glyph: "split",
    gas: 88_000,
    maturity: "review",
    params: [
      { key: "legs", label: "Legs", type: "number", value: 2, min: 2, max: 4, step: 1 },
      { key: "primary", label: "Primary weight", type: "number", value: 60, min: 10, max: 90, step: 5, suffix: "%" },
    ],
  },
  {
    id: "bridge",
    name: "Bridge",
    kind: "action",
    category: "bridge",
    blurb: "Move the balance to another chain.",
    detail:
      "Hands off to a canonical bridge with a fixed destination recipient. The zap treats the far side as untrusted until the arrival attestation lands.",
    accepts: "token",
    emits: "token",
    glyph: "bridge",
    gas: 168_000,
    maturity: "review",
    params: [
      { key: "chain", label: "Destination", type: "select", value: "Base", options: ["Base", "Arbitrum", "Optimism", "Robinhood Chain"] },
    ],
  },
  {
    id: "supply",
    name: "Supply",
    kind: "action",
    category: "lend",
    blurb: "Deposit into a lending market.",
    detail:
      "Supplies the incoming balance and returns the market's share token. Interest accrues to the share, so the receipt is what the rest of the chain moves.",
    accepts: "token",
    emits: "receipt",
    glyph: "vault",
    gas: 154_000,
    maturity: "preview",
    params: [
      { key: "market", label: "Market", type: "select", value: "Morpho", options: ["Morpho", "Aave v3", "Compound v3"] },
    ],
  },
  {
    id: "borrow",
    name: "Borrow",
    kind: "action",
    category: "lend",
    blurb: "Draw a loan against the supplied position.",
    detail:
      "Opens a debt line against the share you just minted. The health-factor floor is enforced before and after execution — a borrow that would breach it reverts.",
    accepts: "receipt",
    emits: "debt",
    glyph: "borrow",
    gas: 186_000,
    maturity: "review",
    params: [
      { key: "asset", label: "Borrow", type: "select", value: "USDC", options: ["USDC", "WETH", "DAI"] },
      { key: "ltv", label: "Target LTV", type: "number", value: 45, min: 5, max: 80, step: 5, suffix: "%" },
    ],
  },
  {
    id: "draw-debt",
    name: "Draw to wallet",
    kind: "action",
    category: "lend",
    blurb: "Realise the borrowed balance as tokens.",
    detail:
      "Turns an open debt line into spendable ERC-20. Kept as its own block so a leverage loop has to state the step where risk becomes real.",
    accepts: "debt",
    emits: "token",
    glyph: "download",
    gas: 64_000,
    maturity: "review",
    params: [],
  },
  {
    id: "add-liquidity",
    name: "Add liquidity",
    kind: "action",
    category: "liquidity",
    blurb: "Deposit into a pool and take the position.",
    detail:
      "Provisions both sides of a range and mints the position. The range bounds are signed, so an executor cannot quietly widen your exposure.",
    accepts: "token",
    emits: "lp",
    glyph: "pool",
    gas: 214_000,
    maturity: "preview",
    params: [
      { key: "pool", label: "Pool", type: "select", value: "WETH/USDC", options: ["WETH/USDC", "cbBTC/USDC", "0xZAPS/WETH"] },
      { key: "width", label: "Range width", type: "number", value: 20, min: 2, max: 100, step: 2, suffix: "%" },
    ],
  },
  {
    id: "remove-liquidity",
    name: "Remove liquidity",
    kind: "action",
    category: "liquidity",
    blurb: "Burn the position back into tokens.",
    detail: "Withdraws the position and its accrued fees. Used to close a chain, or to rebalance into a fresh range.",
    accepts: "lp",
    emits: "token",
    glyph: "poolOut",
    gas: 176_000,
    maturity: "preview",
    params: [
      { key: "portion", label: "Withdraw", type: "number", value: 100, min: 5, max: 100, step: 5, suffix: "%" },
    ],
  },
  {
    id: "stake",
    name: "Stake position",
    kind: "action",
    category: "liquidity",
    blurb: "Deposit the LP into a gauge or farm.",
    detail: "Locks the position into an allowlisted gauge and returns the staked receipt that rewards accrue against.",
    accepts: "lp",
    emits: "receipt",
    glyph: "lock",
    gas: 122_000,
    maturity: "preview",
    params: [
      { key: "gauge", label: "Gauge", type: "select", value: "Protocol gauge", options: ["Protocol gauge", "Partner farm"] },
    ],
  },
  {
    id: "accrue",
    name: "Accrue rewards",
    kind: "action",
    category: "yield",
    blurb: "Let the receipt build a claimable balance.",
    detail: "A no-op onchain — it exists so the chain can name the waiting period between staking and harvesting.",
    accepts: "receipt",
    emits: "yield",
    glyph: "sparkle",
    gas: 0,
    maturity: "preview",
    params: [
      { key: "window", label: "Every", type: "select", value: "weekly", options: ["daily", "weekly", "monthly"] },
    ],
  },
  {
    id: "harvest",
    name: "Harvest",
    kind: "action",
    category: "yield",
    blurb: "Claim the accrued rewards as tokens.",
    detail:
      "Claims from the allowlisted reward source with a balance-delta postcondition, so a claim that returns nothing fails loudly instead of silently.",
    accepts: "yield",
    emits: "token",
    glyph: "harvest",
    gas: 118_000,
    maturity: "preview",
    params: [],
  },
  {
    id: "unwrap",
    name: "Wrap / unwrap",
    kind: "action",
    category: "swap",
    blurb: "Convert between native and wrapped.",
    detail: "A direct call to the canonical wrapper. No adapter, no price, no slippage surface.",
    accepts: "token",
    emits: "token",
    glyph: "wrap",
    gas: 48_000,
    maturity: "live",
    params: [
      { key: "mode", label: "Mode", type: "select", value: "wrap", options: ["wrap", "unwrap"] },
    ],
  },

  // ---- guards ------------------------------------------------------------
  {
    id: "guard-slippage",
    name: "Slippage cap",
    kind: "guard",
    category: "guard",
    blurb: "Bound the worst acceptable fill.",
    detail: "Converts to a minimum-out on every priced step downstream. Anything worse reverts the whole chain.",
    accepts: null,
    emits: null,
    glyph: "shield",
    gas: 0,
    maturity: "live",
    params: [
      { key: "bps", label: "Max slippage", type: "number", value: 50, min: 5, max: 500, step: 5, suffix: "bps" },
    ],
  },
  {
    id: "guard-spend",
    name: "Spend ceiling",
    kind: "guard",
    category: "guard",
    blurb: "Designed to cap total outflow. Not enforced onchain.",
    detail: "Designed to cap total outflow across every run. The v1.1 policy tracks no cumulative budget, so this is not enforced onchain. The only bound a deployed capsule carries is the single step amount you sign.",
    accepts: null,
    emits: null,
    glyph: "gauge",
    gas: 0,
    maturity: "live",
    params: [
      { key: "cap", label: "Lifetime cap", type: "number", value: 1000, min: 0, max: 10_000_000, step: 100 },
    ],
  },
  {
    id: "guard-oracle",
    name: "Price band",
    kind: "guard",
    category: "guard",
    blurb: "Designed to hold execution inside an oracle band. Not enforced onchain.",
    detail: "Designed to read an allowlisted oracle before execution and refuse to run outside the band. The v1.1 policy has no oracle precondition, so nothing checks the band before execution.",
    accepts: null,
    emits: null,
    glyph: "band",
    gas: 24_000,
    maturity: "review",
    params: [
      { key: "band", label: "Band", type: "number", value: 3, min: 1, max: 25, step: 1, suffix: "%" },
    ],
  },
  {
    id: "guard-window",
    name: "Time window",
    kind: "guard",
    category: "guard",
    blurb: "Designed to bound when execution may happen. Not enforced onchain.",
    detail: "Designed to bound execution to a cadence and a deadline. The v1.1 policy has no expiry or cadence field, so a deployed capsule stays executable until you withdraw or recover it.",
    accepts: null,
    emits: null,
    glyph: "clock",
    gas: 0,
    maturity: "live",
    params: [
      { key: "expiry", label: "Expires in", type: "select", value: "30 days", options: ["7 days", "30 days", "90 days", "never"] },
    ],
  },
  {
    id: "guard-approval",
    name: "Human gate",
    kind: "guard",
    category: "guard",
    blurb: "Designed to require a signature per run. Not enforced onchain.",
    detail: "Designed to make every execution wait for a fresh signature. The v1.1 policy has no per-run approval step, so the signed policy is the only authority, bounded by its amount.",
    accepts: null,
    emits: null,
    glyph: "hand",
    gas: 0,
    maturity: "live",
    params: [],
  },
  {
    id: "guard-private",
    name: "Private submission",
    kind: "guard",
    category: "guard",
    blurb: "Designed to route around the public mempool. Not enforced onchain.",
    detail: "Designed to send through a private relay so a searcher cannot see the pending transaction before it lands. The v1.1 policy cannot bind a submitter, so whoever executes the capsule chooses the mempool path.",
    accepts: null,
    emits: null,
    glyph: "eyeOff",
    gas: 0,
    maturity: "live",
    params: [],
  },

  // ---- sinks -------------------------------------------------------------
  {
    id: "send",
    name: "Send to recipient",
    kind: "sink",
    category: "sink",
    blurb: "Settle to a fixed address.",
    detail: "The recipient is bound into the policy hash. Changing it is a new policy and a new signature — never a config edit.",
    accepts: "token",
    emits: null,
    glyph: "send",
    gas: 34_000,
    maturity: "live",
    params: [
      { key: "recipient", label: "Recipient", type: "select", value: "owner wallet", options: ["owner wallet", "custom address"] },
    ],
  },
  {
    id: "hold",
    name: "Hold in zap",
    kind: "sink",
    category: "sink",
    blurb: "Leave the position inside the capsule.",
    detail: "The capsule keeps custody until the owner withdraws or triggers the emergency exit. Nothing else can move it.",
    accepts: "receipt",
    emits: null,
    glyph: "safe",
    gas: 0,
    maturity: "live",
    params: [],
  },
  {
    id: "hold-lp",
    name: "Hold position",
    kind: "sink",
    category: "sink",
    blurb: "Park an LP position in the capsule.",
    detail: "Same custody rules as a held share, for chains that end on an open liquidity position.",
    accepts: "lp",
    emits: null,
    glyph: "safe",
    gas: 0,
    maturity: "preview",
    params: [],
  },
  {
    id: "loop",
    name: "Loop back",
    kind: "sink",
    category: "sink",
    blurb: "Feed the output into the next run.",
    detail:
      "Compounds the result into the first action instead of settling. It is the easiest way to build unbounded exposure, and the v1.1 policy tracks no cumulative budget that would bound it.",
    accepts: "token",
    emits: null,
    glyph: "loop",
    gas: 12_000,
    maturity: "review",
    params: [
      { key: "runs", label: "Max loops", type: "number", value: 4, min: 1, max: 12, step: 1 },
    ],
  },
];

const BLOCK_INDEX = new Map(BLOCKS.map((block) => [block.id, block]));

export function getBlock(id: string): LegoBlock | undefined {
  return BLOCK_INDEX.get(id);
}

/** A placed block: a catalog reference plus the values the builder edited. */
export type ChainNode = {
  /** Stable per-placement id so the same block can appear twice. */
  uid: string;
  blockId: string;
  params: Record<string, ParamValue>;
};

export function defaultParams(block: LegoBlock): Record<string, ParamValue> {
  return Object.fromEntries(block.params.map((param) => [param.key, param.value]));
}

export function makeNode(blockId: string, uid: string, overrides: Record<string, ParamValue> = {}): ChainNode {
  const block = getBlock(blockId);
  return { uid, blockId, params: block ? { ...defaultParams(block), ...overrides } : { ...overrides } };
}

// ---- sharing ---------------------------------------------------------------

/** Nothing legitimate comes close; the cap just bounds the parse work. */
const MAX_TOKEN_LENGTH = 8_000;
const MAX_SHARED_NODES = 64;
const MAX_UID_LENGTH = 64;
const MAX_TEXT_LENGTH = 200;
/** Same shape `parseRouterAmount` accepts, minus the wei-range check. */
const AMOUNT_PATTERN = /^\d{0,30}(?:\.\d{0,18})?$/;

/**
 * A chain packed into a URL-safe token: `[blockId, params, uid]` triples.
 *
 * Positional tuples rather than objects because this ends up in a query string
 * and every key name would be paid for twice — once in the JSON, again in the
 * base64 expansion.
 */
export function encodeChain(chain: readonly ChainNode[]): string {
  return base64UrlEncode(JSON.stringify(chain.map((node) => [node.blockId, node.params, node.uid])));
}

/**
 * Read a shared chain back, or `null` if the token is not one.
 *
 * This value arrives from a URL a stranger controls, so nothing inside it is
 * trusted: unknown block ids are dropped rather than rendered as holes, every
 * param key is looked up in the catalog, and every value is checked against the
 * param's own declared domain. What survives is a chain the builder could have
 * produced itself.
 */
export function decodeChain(token: string): ChainNode[] | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  const json = base64UrlDecode(token);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const nodes: ChainNode[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.slice(0, MAX_SHARED_NODES)) {
    if (!Array.isArray(entry)) continue;
    const [blockId, rawParams, rawUid] = entry as [unknown, unknown, unknown];
    if (typeof blockId !== "string") continue;
    const block = getBlock(blockId);
    if (!block) continue;

    let uid =
      typeof rawUid === "string" && rawUid.length > 0 && rawUid.length <= MAX_UID_LENGTH
        ? rawUid
        : `s${nodes.length}`;
    // Duplicate uids would collide as React keys and make the wrong card
    // respond to a delete, so a repeat gets its own suffix.
    while (seen.has(uid)) uid = `${uid}-${nodes.length}`;
    seen.add(uid);

    nodes.push({ uid, blockId, params: { ...defaultParams(block), ...sharedParams(block, rawParams) } });
  }
  return nodes;
}

/**
 * Read a design back from whatever a user has on their clipboard.
 *
 * The builder hands out two representations — a `?d=` share link and the
 * "Copy design JSON" export — and until now accepted only the first, and only
 * by being navigated to. A design mailed to a colleague as JSON had no way
 * back in. This takes either, plus the bare token and the bare `chain` array,
 * because someone pasting from a chat window will have grabbed whichever part
 * looked like the answer.
 *
 * Everything lands in the same catalog validation `decodeChain` uses: this
 * text is no more trusted for arriving through a paste than through a URL.
 */
export function decodeDesign(text: string): ChainNode[] | null {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return null;

  // A share link, or anything else carrying the query key. Parsed as a URL
  // when it is one so that a trailing `#anchor` or extra params cannot end up
  // inside the token, and by hand when it is a bare `?d=…` fragment.
  const fromQuery = trimmed.match(/[?&]d=([A-Za-z0-9_-]+)/);
  if (fromQuery) return nonEmpty(decodeChain(fromQuery[1]));

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const chain = Array.isArray(parsed) ? parsed : (parsed as { chain?: unknown } | null)?.chain;
    return nonEmpty(nodesFromExport(chain));
  }

  return nonEmpty(decodeChain(trimmed));
}

/** The `chain` array of a design export, validated back into placements. */
function nodesFromExport(raw: unknown): ChainNode[] | null {
  if (!Array.isArray(raw)) return null;
  const nodes: ChainNode[] = [];
  for (const [index, entry] of raw.slice(0, MAX_SHARED_NODES).entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { block: blockId, params } = entry as { block?: unknown; params?: unknown };
    if (typeof blockId !== "string") continue;
    const block = getBlock(blockId);
    if (!block) continue;
    // The export carries no uids — it is a description of a design, not of a
    // canvas — so every placement is renamed here rather than risking a
    // collision with whatever is already on the board.
    nodes.push({ uid: `i${index}`, blockId, params: { ...defaultParams(block), ...sharedParams(block, params) } });
  }
  return nodes;
}

function nonEmpty(nodes: ChainNode[] | null): ChainNode[] | null {
  return nodes && nodes.length > 0 ? nodes : null;
}

function sharedParams(block: LegoBlock, raw: unknown): Record<string, ParamValue> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const params: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const param = block.params.find((entry) => entry.key === key);
    if (!param) continue;
    switch (param.type) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        // Clamped rather than dropped: a shared slider position outside the
        // catalog's range is still a legible intent, just not a legal one.
        params[key] = Math.min(param.max, Math.max(param.min, value));
        break;
      case "select":
        if (typeof value !== "string" || !param.options.includes(value)) continue;
        params[key] = value;
        break;
      case "amount":
        if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) continue;
        params[key] = value;
        break;
      case "text":
        if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) continue;
        params[key] = value;
        break;
    }
  }
  return params;
}

// `btoa`/`atob` are the one base64 pair both the browser and Node ship, and the
// TextEncoder bridge is what keeps them correct for anything outside Latin-1.
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(token: string): string | null {
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (token.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Shape flowing *into* a position, ignoring guards.
 *
 * Guards constrain a chain without transforming it, so they are transparent to
 * the connector maths — which is exactly why a guard can be dropped anywhere
 * downstream of a source without breaking the fit.
 */
export function shapeBefore(chain: readonly ChainNode[], index: number): FlowShape | null {
  let shape: FlowShape | null = null;
  for (let i = 0; i < index && i < chain.length; i++) {
    const block = getBlock(chain[i].blockId);
    if (!block || block.kind === "guard") continue;
    shape = block.emits;
  }
  return shape;
}

/**
 * Whether `block` can legally be inserted at `index` of `chain`.
 *
 * This is the single rule the canvas, the arrow buttons, and the palette's
 * "does it fit" dimming all consult, and it agrees with `compileChain` by
 * construction: anything this accepts compiles without a blocking issue.
 */
export function canInsert(chain: readonly ChainNode[], block: LegoBlock, index: number): boolean {
  const incoming = shapeBefore(chain, index);
  // Guards constrain rather than transform, so they seat at any point where
  // value is actually flowing — but only there. Above the source, or below the
  // sink that ends the chain, nothing is passing for a guard to bind, and
  // `compileChain` says so: it calls that placement orphaned and warns that the
  // guard has nothing to guard yet. Letting it seat anyway is how a one-tap
  // "add the missing guard" ends up parking a red card under the settlement.
  if (block.kind === "guard") return incoming !== null;
  if (block.kind === "source" && (incoming !== null || hasSource(chain))) return false;
  if (block.kind !== "source" && block.accepts !== incoming) return false;

  // A block that lands mid-chain also has to seat the piece that follows it.
  const next = nextConsumer(chain, index);
  return next === null || next.kind === "source" ? true : next.accepts === block.emits;
}

function hasSource(chain: readonly ChainNode[]): boolean {
  return chain.some((node) => getBlock(node.blockId)?.kind === "source");
}

function nextConsumer(chain: readonly ChainNode[], index: number): LegoBlock | null {
  for (let i = index; i < chain.length; i++) {
    const block = getBlock(chain[i].blockId);
    if (block && block.kind !== "guard") return block;
  }
  return null;
}

export type Joint = {
  /** Index of the node *below* this joint. */
  index: number;
  shape: FlowShape | null;
  status: "ok" | "mismatch" | "orphan";
};

/**
 * `code` names the fault so callers can act on it without matching prose.
 *
 * `orphan` and `mismatch` are the two purely *structural* faults — the ones
 * that depend on the order blocks were placed in — which is what lets the
 * deployability mapper reject a chain it would otherwise wave through: it
 * counts kinds, and only the compiler knows whether they seat.
 */
export type ChainIssueCode = "unknown-block" | "duplicate-source" | "orphan" | "mismatch";

export type ChainIssue = { level: "block" | "warn"; message: string; uid?: string; code?: ChainIssueCode };

export type CompiledZap = {
  status: "pass" | "warn" | "block";
  joints: Joint[];
  issues: ChainIssue[];
  checks: SimulationCheck[];
  hash: string;
  gas: number;
  /** 0-100; how much of the chain's risk surface is covered by guards. */
  guardScore: number;
  /** The guards that risk surface asks for and the chain does not have. */
  missingGuards: GuardDemand[];
  steps: string[];
  outputShape: FlowShape | null;
};

export type SlippageResolution = {
  /** Every cap that parsed as a number, in the order it was placed. */
  caps: number[];
  /** Caps that are not numbers at all, as written, in the order placed. */
  invalid: string[];
  /** The cap that governs, or `null` when the design states none. */
  governingBps: number | null;
};

/**
 * Which slippage cap a chain actually means, when it states more than one.
 *
 * Nothing stops a design carrying several `guard-slippage` blocks — a palette
 * tap seats a guard anywhere below the source, and a shared link can encode as
 * many as it likes. Someone who draws a 0.10% cap and a 5.00% cap has asked for
 * both bounds at once, and only the tighter of the two honours both, so the
 * TIGHTEST governs. Chain order must never decide it: "the last one wins" would
 * silently hand a 50x looser bound to whoever happened to drop their caps in an
 * unlucky order.
 *
 * This is the single answer both the readout's Slippage check and the deploy
 * handoff read, so the two panels cannot claim different caps for one design.
 */
export function resolveSlippageGuards(chain: readonly ChainNode[]): SlippageResolution {
  const caps: number[] = [];
  const invalid: string[] = [];
  for (const node of chain) {
    if (node.blockId !== "guard-slippage") continue;
    const bps = Number(node.params.bps);
    if (!Number.isFinite(bps)) {
      invalid.push(String(node.params.bps));
      continue;
    }
    caps.push(bps);
  }
  return { caps, invalid, governingBps: caps.length > 0 ? Math.min(...caps) : null };
}

/**
 * Turn a chain into the same shape of verdict the rest of the product speaks:
 * a status, a hash, and a list of named checks.
 */
export function compileChain(chain: readonly ChainNode[]): CompiledZap {
  const joints: Joint[] = [];
  const issues: ChainIssue[] = [];
  const steps: string[] = [];
  let shape: FlowShape | null = null;
  let gas = 21_000;
  let sourceCount = 0;

  chain.forEach((node, index) => {
    const block = getBlock(node.blockId);
    if (!block) {
      issues.push({ level: "block", message: "Unknown block in this chain.", uid: node.uid, code: "unknown-block" });
      return;
    }
    gas += block.gas;

    if (block.kind === "guard") {
      joints.push({ index, shape, status: shape === null && index > 0 ? "orphan" : "ok" });
      if (index === 0 || shape === null) {
        issues.push({ level: "warn", message: `${block.name} has nothing to guard yet — add a source above it.`, uid: node.uid });
      }
      steps.push(describe(block, node));
      return;
    }

    if (block.kind === "source") {
      sourceCount += 1;
      // A source is legal wherever nothing has flowed yet — a guard sitting
      // above it is untidy (and warned about) but not broken.
      const legal = shape === null && sourceCount === 1;
      joints.push({ index, shape: null, status: legal ? "ok" : "mismatch" });
      if (!legal) {
        issues.push({
          level: "block",
          message: `${block.name} is a source — a chain draws from exactly one.`,
          uid: node.uid,
          code: "duplicate-source",
        });
      }
      shape = block.emits;
      steps.push(describe(block, node));
      return;
    }

    const fits = block.accepts === shape;
    joints.push({ index, shape, status: shape === null ? "orphan" : fits ? "ok" : "mismatch" });
    if (shape === null) {
      issues.push({ level: "block", message: `${block.name} needs a source above it.`, uid: node.uid, code: "orphan" });
    } else if (!fits) {
      issues.push({
        level: "block",
        message: `${block.name} takes ${SHAPE_LABEL[block.accepts as FlowShape]} but receives ${SHAPE_LABEL[shape]}.`,
        uid: node.uid,
        code: "mismatch",
      });
    }
    shape = block.emits;
    steps.push(describe(block, node));
  });

  const placed = chain.flatMap((node) => getBlock(node.blockId) ?? []);
  const settles = placed.some((block) => block.kind === "sink");
  if (placed.length > 0 && !settles) {
    issues.push({ level: "warn", message: "Nothing settles this chain — add a settlement block so the value has somewhere to land." });
  }
  if (placed.length === 0) {
    issues.push({ level: "warn", message: "Empty canvas. Drop a source to start." });
  }

  const guards = auditGuardCoverage(placed);
  const checks = buildChecks(placed, chain, guards, issues);
  const status = checks.some((check) => check.status === "block")
    ? "block"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    status,
    joints,
    issues,
    checks,
    hash: policyHash(chain.map((node) => ({ block: node.blockId, params: node.params }))),
    gas,
    guardScore: guards.score,
    missingGuards: guards.missing,
    steps,
    outputShape: shape,
  };
}

/** A guard this chain's risk surface asks for, and the risk that asks for it. */
export type GuardDemand = {
  /** Catalog id of the guard that answers this risk. */
  guardId: string;
  /** What the placed blocks introduced, in the user's terms. */
  risk: string;
};

export type GuardAudit = {
  /** 0-100; the share of demanded guards actually present. */
  score: number;
  /** Demanded guards that are not in the chain, in catalog order. */
  missing: GuardDemand[];
};

/**
 * Which guards this chain's risk surface asks for, and which are absent.
 *
 * This is the builder's editorial opinion, not a contract rule: each risk the
 * placed blocks introduce demands a specific guard. A chain with no risk
 * surface demands nothing and scores 100.
 *
 * The unmet demands are returned rather than folded away into the percentage
 * because "50% guarded" is not actionable — the number tells someone they are
 * exposed without telling them to what, or which piece closes it.
 */
export function auditGuardCoverage(placed: readonly LegoBlock[]): GuardAudit {
  const has = (id: string): boolean => placed.some((block) => block.id === id);
  const demands: Array<GuardDemand & { needed: boolean }> = [
    {
      // Anything priced can be filled badly.
      needed: placed.some((block) => block.category === "swap" || block.category === "liquidity"),
      guardId: "guard-slippage",
      risk: "this chain prices a trade, so it can be filled worse than quoted",
    },
    {
      // Anything that pulls repeatedly can drain.
      needed: placed.some((block) => block.id === "recurring-stream" || block.id === "loop"),
      guardId: "guard-spend",
      risk: "this chain draws more than once, so its total outflow is unbounded",
    },
    {
      // Anything leveraged can be liquidated on a wick.
      needed: placed.some((block) => block.category === "lend"),
      guardId: "guard-oracle",
      risk: "this chain takes on leverage, so a price wick can liquidate it",
    },
    {
      // Any standing authority should expire.
      needed: placed.some((block) => block.kind === "source"),
      guardId: "guard-window",
      risk: "this chain signs a standing authority, so it never expires on its own",
    },
  ];

  const active = demands.filter((demand) => demand.needed);
  if (active.length === 0) return { score: 100, missing: [] };
  const met = active.filter((demand) => has(demand.guardId));
  return {
    score: Math.round((met.length / active.length) * 100),
    missing: active
      .filter((demand) => !has(demand.guardId))
      .map(({ guardId, risk }) => ({ guardId, risk })),
  };
}

/** How well guarded a chain is, as a percentage. */
export function scoreGuardCoverage(placed: readonly LegoBlock[]): number {
  return auditGuardCoverage(placed).score;
}

function buildChecks(
  placed: readonly LegoBlock[],
  chain: readonly ChainNode[],
  guards: GuardAudit,
  issues: readonly ChainIssue[],
): SimulationCheck[] {
  const checks: SimulationCheck[] = [];
  const blocking = issues.filter((issue) => issue.level === "block");

  checks.push({
    label: "Connector fit",
    detail: blocking.length
      ? `${blocking.length} joint${blocking.length === 1 ? "" : "s"} do not seat: ${blocking[0].message}`
      : "Every block accepts the shape the block above it emits.",
    status: blocking.length ? "block" : "pass",
  });

  const worst = placed.reduce<BlockMaturity>((acc, block) => {
    const rank: Record<BlockMaturity, number> = { live: 0, preview: 1, review: 2, blocked: 3 };
    return rank[block.maturity] > rank[acc] ? block.maturity : acc;
  }, "live");
  checks.push({
    label: "Block maturity",
    detail:
      worst === "blocked"
        ? "This chain contains a block that is deliberately disabled until its review clears."
        : worst === "review"
          ? "At least one block needs adapter review before it can hold mainnet funds."
          : worst === "preview"
            ? "Preview blocks are safe for simulation and testnet, not for size."
            : "Every block in this chain is on the live adapter set.",
    status: worst === "blocked" ? "block" : worst === "review" ? "warn" : "pass",
  });

  // The governing cap, never the first one placed: this check sits beside a
  // deploy CTA that states the cap it will hand over, and the two reading
  // different guards is how a design ends up showing a reassuring green tick
  // next to a bound 50x looser.
  const slippage = resolveSlippageGuards(chain);
  if (slippage.governingBps !== null) {
    const bps = slippage.governingBps;
    const stacked =
      slippage.caps.length > 1
        ? ` ${slippage.caps.length} caps are placed (${slippage.caps.map((cap) => `${cap} bps`).join(", ")}) — the tightest, ${bps} bps, is the one that governs.`
        : "";
    checks.push({
      label: "Slippage",
      detail:
        (bps <= 100
          ? "Slippage is bounded at or below 1.00%."
          : bps <= 250
            ? "Slippage is above the default safety band and should require a human gate."
            : "Slippage is far too wide for an unattended executor — at this cap a fill can come back dramatically worse than quoted.") + stacked,
      // Never "block", however wide. The live app signs caps up to 500 bps from
      // its own slider, so a wide cap is a risk the user can legitimately take,
      // not a chain that cannot be built — and "block" is reserved for
      // structural faults so the top-line verdict keeps meaning one precise
      // thing. Grading this as a fault also put the readout in direct
      // contradiction with the deploy CTA, which correctly still offered a cap
      // the contracts accept.
      status: bps <= 100 ? "pass" : "warn",
    });
  }

  // Deliberately never blocking: an unguarded chain still assembles and still
  // simulates. Reserving "block" for structural faults keeps the top-line
  // verdict meaning one precise thing — that the chain cannot be compiled.
  checks.push({
    label: "Guard coverage",
    detail:
      guards.missing.length === 0
        ? "Every risk this chain introduces has a matching guard."
        : // Named, not counted. A bare percentage tells someone they are
          // exposed without telling them to what — and the missing piece is
          // the only part of this sentence they can act on.
          `${guards.score}% guarded. Missing: ${guards.missing
            .map((demand) => getBlock(demand.guardId)?.name ?? demand.guardId)
            .join(", ")}. Drop them anywhere below the source.`,
    status: guards.missing.length === 0 ? "pass" : "warn",
  });

  const loop = chain.find((node) => node.blockId === "loop");
  if (loop) {
    const runs = Number(loop.params.runs ?? 0);
    checks.push({
      label: "Loop bound",
      detail:
        runs > 0 && runs <= 8
          ? `Compounding stops after ${runs} runs.`
          : "An unbounded or very deep loop compounds exposure faster than a human can review it.",
      status: runs > 0 && runs <= 8 ? "pass" : "block",
    });
  }

  checks.push({
    label: "Authority",
    detail: placed.some((block) => block.id === "guard-approval")
      ? "Every run waits for a fresh wallet signature."
      : "The signed policy is the only authority — bounded by its guards and revocable at any time.",
    status: "pass",
  });

  return checks;
}

function describe(block: LegoBlock, node: ChainNode): string {
  const parts = Object.entries(node.params).map(([key, value]) => {
    const param = block.params.find((entry) => entry.key === key);
    return `${key} ${value}${paramSuffix(param)}`;
  });
  return parts.length ? `${block.name} (${parts.join(", ")})` : block.name;
}

/** Trailing unit for a param value, if the catalog gives it one. */
export function paramSuffix(param: BlockParam | undefined): string {
  if (!param) return "";
  if (param.type === "number") return param.suffix ?? "";
  if (param.type === "amount") return param.unit ? ` ${param.unit}` : "";
  return "";
}

/** Ready-made chains, one per kind of zap the builder is meant to express. */
export type ZapRecipe = {
  id: string;
  name: string;
  tagline: string;
  accent: FlowShape;
  blocks: Array<[string, Record<string, ParamValue>?]>;
};

export const RECIPES: readonly ZapRecipe[] = [
  {
    // First, and the chain the builder opens on, because it is the only one of
    // these that the deployed contracts can actually carry. Every other
    // blueprint here is a design; a user who loaded one and read the rejection
    // list had to reverse-engineer this shape from a list of things it is not.
    //
    // Its exact contents are the reduction rules in `deployable.ts` read
    // forwards — WETH in, 0xZAPS out, Uniswap v4, settled to the owner wallet,
    // an amount the router's own parser accepts. A test holds the two together,
    // because a catalog edit that quietly drops this off the live route would
    // otherwise leave the front door pointing nowhere.
    id: "live-route",
    name: "Live route",
    tagline: "The one chain today's contracts can carry: aeWETH into 0xZAPS.",
    accent: "token",
    blocks: [
      ["wallet-balance", { asset: "WETH", amount: "0.05" }],
      ["guard-slippage", { bps: 50 }],
      ["swap", { into: "0xZAPS", venue: "Uniswap v4" }],
      ["send", { recipient: "owner wallet" }],
    ],
  },
  {
    id: "dca",
    name: "Recurring DCA",
    tagline: "Buy the same size every week, straight to your wallet.",
    accent: "token",
    blocks: [["recurring-stream"], ["guard-spend"], ["guard-slippage"], ["guard-window"], ["swap"], ["send"]],
  },
  {
    id: "lp-autocompound",
    name: "LP autocompound",
    tagline: "Provide liquidity, stake it, and fold the rewards back in.",
    accent: "lp",
    blocks: [
      ["wallet-balance", { asset: "USDC", amount: "1000" }],
      ["guard-slippage"],
      ["guard-window"],
      ["add-liquidity"],
      ["stake"],
      ["accrue"],
      ["harvest"],
      ["loop", { runs: 6 }],
    ],
  },
  {
    id: "claim-compound",
    name: "Claim & compound",
    tagline: "Harvest what has accrued and buy more of the asset.",
    accent: "yield",
    blocks: [["pending-rewards"], ["guard-slippage"], ["guard-window"], ["harvest"], ["swap"], ["send"]],
  },
  {
    id: "leverage",
    name: "Leverage loop",
    tagline: "Supply, borrow, and re-supply inside a bounded LTV.",
    accent: "debt",
    blocks: [
      ["wallet-balance", { asset: "WETH", amount: "2" }],
      ["guard-oracle"],
      ["guard-spend"],
      ["guard-window"],
      ["supply"],
      ["borrow"],
      ["draw-debt"],
      ["loop", { runs: 3 }],
    ],
  },
  {
    id: "bridge-deposit",
    name: "Bridge & deposit",
    tagline: "Move to another chain and park it in a market.",
    accent: "receipt",
    blocks: [["wallet-balance"], ["guard-window"], ["guard-private"], ["bridge"], ["supply"], ["hold"]],
  },
  {
    id: "exit",
    name: "Guarded exit",
    tagline: "Unwind a position back to stables when the band breaks.",
    accent: "lp",
    blocks: [
      ["wallet-balance", { asset: "WETH", amount: "1" }],
      ["guard-oracle"],
      ["guard-slippage"],
      ["guard-window"],
      ["add-liquidity"],
      ["remove-liquidity"],
      ["swap", { into: "USDC" }],
      ["send"],
    ],
  },
];
