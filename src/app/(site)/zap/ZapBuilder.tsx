"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPublicClient, formatUnits, http, zeroAddress } from "viem";

import { CopyButton } from "@/components/CopyButton";
import { trackEvent } from "@/lib/analytics";
import {
  BLOCKS,
  CATEGORY_LABEL,
  RECIPES,
  SHAPE_COLOR,
  SHAPE_LABEL,
  canInsert,
  composeBlockStack,
  compileChain,
  decodeChain,
  decodeDesign,
  encodeChain,
  getBlock,
  makeNode,
  paramSuffix,
  type BlockCategory,
  type BlockParam,
  type ChainNode,
  type FlowShape,
  type LegoBlock,
  type ParamValue,
  type ZapRecipe,
} from "@/lib/blocks";
import { DEFAULT_SLIPPAGE_BPS, reduceChainToLiveRoute } from "@/lib/deployable";
import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICY_BLOCK_IDS,
  resolveExecutionPolicy,
} from "@/lib/execution-policy";

import { automationHandoff, reduceChainToAutomation } from "@/lib/automation-design";
import { builderQuoteEconomics } from "@/lib/build-quote";
import {
  MAX_DESIGN_NAME,
  MAX_SAVED_DESIGNS,
  decodeSavedDesign,
  readDesignLibrary,
  removeDesign,
  renameDesign,
  upsertDesign,
  writeDesignLibrary,
  type SavedDesign,
} from "@/lib/designs";
import { edgeScrollDelta } from "@/lib/drag";
import { reducedMotionEnabled } from "@/lib/motion-preference";
import { parseRouterAmount } from "@/lib/openzap";
import { protocolsForAction } from "@/lib/protocols";
import { quoteRoute } from "@/lib/route-quote";
import { resolveRouteById } from "@/lib/routes";
import {
  OPENZAP_CREATION_FEE,
  OPENZAP_CREATION_FEE_SLIPPAGE_BPS,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "@/lib/robinhood";
import { ProtocolStack } from "@/components/ProtocolLogo";
import { BlockGlyph } from "./BlockGlyph";
import styles from "./build.module.css";

const STORAGE_KEY = "openzaps:zap-builder:v1";
/** Query key a shared design travels under. */
const SHARE_PARAM = "d";
/** Pointer travel before a press becomes a drag, so taps still register. */
const DRAG_THRESHOLD = 6;
/**
 * How many steps back the canvas remembers.
 *
 * Deep enough that "undo until it looks right again" always works on a real
 * session, bounded so a long slider drag cannot grow the tab's memory without
 * limit. Only the chain is held, never a DOM snapshot.
 */
const HISTORY_LIMIT = 60;
/** How long a jumped-to block stays visibly flagged. */
const FLAG_MS = 2200;
/**
 * Said out loud wherever the gas figure appears. It is a sum of hand-written
 * per-block constants from the catalog, not a simulation against a node, and
 * calling it anything firmer would be inventing a measurement.
 */
const GAS_ESTIMATE_NOTE =
  "An estimate: the sum of this build's per-block gas constants. Nothing here was simulated against a node.";

const builderClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 10_000 }),
});
const CREATION_FEE_ROUTE = resolveRouteById("robinhood-v4-weth-zaps");

type BuilderQuoteState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; amountOut: bigint; feeZapsOut: bigint; routeId: string };

/**
 * Palette order. The category tab strip is gone — twenty-four blocks under
 * eight standing headings is one list you can read, where a filter was a
 * control you had to operate before the list told you anything.
 */
const CATEGORY_ORDER: readonly BlockCategory[] = [
  "source",
  "swap",
  "lend",
  "liquidity",
  "yield",
  "bridge",
  "guard",
  "sink",
];

/** The connector-shape key, rendered under the palette beside the port dots. */
const SHAPES: readonly FlowShape[] = ["token", "lp", "receipt", "yield", "debt"];

type DragOrigin =
  | { from: "palette"; blockId: string }
  | { from: "chain"; blockId: string; uid: string; index: number };

type DragState = DragOrigin & {
  pointerId: number;
  /** Viewport position of the pointer. */
  x: number;
  y: number;
  /** Where the press started, so the threshold measures total travel. */
  startX: number;
  startY: number;
  /** Where inside the ghost the pointer grabbed, so it does not jump. */
  dx: number;
  dy: number;
  width: number;
  /** False until the pointer has travelled far enough to mean "drag". */
  active: boolean;
};

let placementCounter = 0;
function nextUid(): string {
  placementCounter += 1;
  return `p${placementCounter}`;
}

function nodesFromRecipe(recipe: ZapRecipe): ChainNode[] {
  return recipe.blocks.map(([id, params], index) => makeNode(id, `${recipe.id}-${index}`, params));
}

type Draft = { chain: ChainNode[]; recipeId: string };

const DEFAULT_DRAFT: Draft = { chain: nodesFromRecipe(RECIPES[0]), recipeId: RECIPES[0].id };

/**
 * Which blueprints reduce to the live route, asked of the same function the
 * deploy panel asks.
 *
 * Derived rather than declared on the recipe, so badges cannot drift from the
 * reducers. A one-sided trigger deliberately does not receive the one-shot
 * badge: running that design immediately would discard the condition.
 * `RECIPES` is static, so this is computed once for the module.
 */
const AUTOMATABLE_RECIPES: ReadonlySet<string> = new Set(
  RECIPES.filter((recipe) => reduceChainToAutomation(nodesFromRecipe(recipe)).deployable).map((recipe) => recipe.id),
);
const DEPLOYABLE_RECIPES: ReadonlySet<string> = new Set(
  RECIPES.filter((recipe) => {
    const nodes = nodesFromRecipe(recipe);
    const automation = reduceChainToAutomation(nodes);
    return reduceChainToLiveRoute(nodes).deployable && !(automation.deployable && automation.mode === "trigger");
  }).map((recipe) => recipe.id),
);

/**
 * The chain this page opens with, resolved once per share token.
 *
 * `useSyncExternalStore` is what makes this hydration-safe: the server snapshot
 * is always `null`, so the server and the first client render agree, and React
 * swaps in the real chain immediately after hydrating. Re-reading on every
 * render would be wrong — the builder writes to storage constantly, so a live
 * read would just echo the component's own state back at it. But the token CAN
 * change under this mounted page now that the landing page renders in-app
 * `<Link href="/zap?d=…">`s, so the cache is keyed by the token it consumed
 * (`consumedToken`) and re-resolves when a client-side navigation brings a
 * different one.
 */
let cachedDraft: Draft | null | undefined;
let consumedToken: string | null | undefined;

function readInitialDraft(token: string | null): Draft | null {
  return readSharedDraft(token) ?? readDraft();
}

/**
 * A design carried in `?d=`, which wins over the saved draft.
 *
 * Following a share link is a request to see *that* design; the local draft is
 * untouched in storage and comes back at a bare /build. The token arrives from
 * `UseSurface`'s `useSearchParams()` (already inside the route's Suspense
 * boundary) rather than `window.location.search`, which lags the router during
 * client-side transitions.
 */
function readSharedDraft(token: string | null): Draft | null {
  try {
    if (!token) return null;
    const chain = decodeChain(token);
    if (!chain || chain.length === 0) return null;
    advancePlacementCounter(chain);
    return { chain, recipeId: "" };
  } catch {
    // A malformed link falls back to the saved draft rather than an error page.
    return null;
  }
}

function readDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Draft>;
    // Drop anything referencing a block this build no longer ships rather than
    // rendering a chain with holes in it.
    const chain = (saved.chain ?? []).filter((node) => node && getBlock(node.blockId));
    if (!chain.length) return null;
    advancePlacementCounter(chain);
    return { chain: chain.map(rebuildNode), recipeId: saved.recipeId ?? "" };
  } catch {
    // A corrupt draft is not worth failing the page over.
    return null;
  }
}

/**
 * Resume the placement counter past the ids already on the canvas.
 *
 * Restored drafts and shared links both carry their original uids, so the next
 * drop has to start above the highest of them — a duplicate uid collides as a
 * React key and makes the wrong card answer a delete.
 */
function advancePlacementCounter(chain: readonly ChainNode[]): void {
  for (const node of chain) {
    const serial = node.uid.match(/^p(\d+)$/);
    if (serial) placementCounter = Math.max(placementCounter, Number(serial[1]));
  }
}

/**
 * Rebuild a restored placement on top of today's catalog defaults.
 *
 * A stored value only survives if its type still matches the param it belongs
 * to. `wallet-balance.amount` used to be a slider number and is now decimal
 * text, so an older draft holds `250` — a figure that meant USDC and would
 * silently reappear as 250 aeWETH, then go straight to the router's amount
 * parser. A param whose unit changed underneath it has no honest reading, so it
 * falls back to the catalog default instead of being coerced.
 */
function rebuildNode(node: ChainNode): ChainNode {
  const block = getBlock(node.blockId);
  if (!block) return node;
  const kept: Record<string, ParamValue> = {};
  for (const param of block.params) {
    const value = node.params?.[param.key];
    if (typeof value === expectedParamType(param)) kept[param.key] = value;
  }
  return makeNode(node.blockId, node.uid, kept);
}

function expectedParamType(param: BlockParam): "number" | "string" {
  return param.type === "number" ? "number" : "string";
}

function draftSnapshot(token: string | null): Draft | null {
  if (cachedDraft === undefined || token !== consumedToken) {
    consumedToken = token;
    cachedDraft = readInitialDraft(token);
  }
  return cachedDraft;
}

function serverSnapshot(): null {
  return null;
}

function originSnapshot(): string {
  return window.location.origin;
}

/** Renders a relative share link until hydration supplies the real origin. */
function serverOrigin(): string {
  return "";
}

/**
 * The stores never emit — token changes arrive as a prop (with a `key` remount
 * from UseSurface), so the store exists purely for its hydration-safe server
 * snapshot.
 */
function subscribeNever(): () => void {
  return () => {};
}

export function ZapBuilder({
  shareToken = null,
}: {
  /** The `?d=` token, from UseSurface's searchParams; null on a bare /zap. */
  shareToken?: string | null;
}): React.JSX.Element {
  // The chain is whatever the user has edited this session, falling back to the
  // saved draft and finally to the opening blueprint.
  const stored = useSyncExternalStore(
    subscribeNever,
    () => draftSnapshot(shareToken),
    serverSnapshot,
  );
  const origin = useSyncExternalStore(subscribeNever, originSnapshot, serverOrigin);
  const [edited, setEdited] = useState<Draft | null>(null);
  const draft = edited ?? stored ?? DEFAULT_DRAFT;
  const chain = draft.chain;
  const recipeId = draft.recipeId;
  // The chain that was last written to storage on purpose. Compared by identity:
  // `commit` hands back a new array for every edit, so the confirmation clears
  // itself the moment the design changes.
  const [savedChain, setSavedChain] = useState<readonly ChainNode[] | null>(null);
  const [openUid, setOpenUid] = useState<string | null>(null);
  // The block a problem was just jumped to, held only long enough to point at.
  const [flaggedUid, setFlaggedUid] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropValid, setDropValid] = useState(false);
  const [runIndex, setRunIndex] = useState(-1);
  const [hint, setHint] = useState("");
  const [narration, setNarration] = useState("");
  // Whole drafts, oldest first. Storing the design rather than a diff is what
  // keeps undo trivially correct: every entry is a state the canvas already
  // rendered once, so restoring one cannot produce a chain that never existed.
  const [past, setPast] = useState<readonly Draft[]>([]);
  const [future, setFuture] = useState<readonly Draft[]>([]);

  const cardRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const recipeRowRef = useRef<HTMLDivElement>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const runTimer = useRef<number | undefined>(undefined);
  const flagTimer = useRef<number | undefined>(undefined);
  /**
   * Which control the last edit came from, so a run of edits to that same
   * control collapses into one undo step. A slider dragged across forty pixels
   * fires forty changes and must still cost exactly one press of ⌘Z.
   */
  const coalesceRef = useRef<string | undefined>(undefined);

  const compiled = useMemo(() => compileChain(chain), [chain]);

  useEffect(() => {
    if (!edited) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(edited));
      // Keep the one-shot snapshot current so leaving and returning to the page
      // restores this session's work, not the draft from page load.
      cachedDraft = edited;
    } catch {
      // Private-mode storage denial: the builder still works in memory.
    }
  }, [edited]);

  useEffect(() => () => {
    window.clearTimeout(hintTimer.current);
    window.clearInterval(runTimer.current);
    window.clearTimeout(flagTimer.current);
  }, []);

  const flash = useCallback((message: string): void => {
    setHint(message);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 2600);
  }, []);

  /**
   * Say what just happened to the chain, for anyone not watching it.
   *
   * Every structural edit — add, remove, move, duplicate, load, import, undo —
   * is visible as a card appearing or sliding, and audible as nothing at all.
   * The arrow buttons were the worst of it: pressing "Move Swap up" left a
   * screen reader with no way to know whether it had moved, or how far it could
   * still go. Each message carries the resulting count or position, which is
   * also what keeps two consecutive edits from producing identical text that a
   * live region would decline to read out twice.
   */
  const announce = useCallback((message: string): void => {
    setNarration(message);
  }, []);

  const stopRun = useCallback((): void => {
    window.clearInterval(runTimer.current);
    runTimer.current = undefined;
    setRunIndex(-1);
  }, []);

  /**
   * Replace the chain. Any edit detaches the draft from its blueprint, so the
   * blueprint row stops claiming credit for a chain the user has changed.
   *
   * This is the only route to a new chain, which is what makes the history
   * exhaustive: there is no mutation that can slip past the undo stack.
   * `coalesceKey` names the control an edit came from — consecutive edits
   * carrying the same key extend the current step instead of adding one.
   */
  const commit = useCallback(
    (next: ChainNode[], recipe = "", coalesceKey?: string): void => {
      stopRun();
      if (coalesceKey === undefined || coalesceRef.current !== coalesceKey) {
        setPast((entries) => [...entries, draft].slice(-HISTORY_LIMIT));
        // A fresh edit is a new branch: whatever was redoable belonged to a
        // future this design no longer has.
        setFuture([]);
      }
      coalesceRef.current = coalesceKey;
      setEdited({ chain: next, recipeId: recipe });
    },
    [draft, stopRun],
  );

  const undo = useCallback((): void => {
    if (past.length === 0) return;
    stopRun();
    setPast((entries) => entries.slice(0, -1));
    setFuture((entries) => [draft, ...entries].slice(0, HISTORY_LIMIT));
    // Never merge an edit into a step that was just travelled through.
    coalesceRef.current = undefined;
    setEdited(past[past.length - 1]);
    announce(`Undone. ${past[past.length - 1].chain.length} blocks. ${past.length - 1} steps left to undo.`);
  }, [announce, draft, past, stopRun]);

  const redo = useCallback((): void => {
    if (future.length === 0) return;
    stopRun();
    setFuture((entries) => entries.slice(1));
    setPast((entries) => [...entries, draft].slice(-HISTORY_LIMIT));
    coalesceRef.current = undefined;
    setEdited(future[0]);
    announce(`Redone. ${future[0].chain.length} blocks. ${future.length - 1} steps left to redo.`);
  }, [announce, draft, future, stopRun]);

  /**
   * ⌘Z / ⌘⇧Z, and their Windows spellings.
   *
   * Bound on the window rather than the canvas because the thing a user wants
   * undone is usually the edit they made from the readout or the palette, and
   * focus is wherever they left it. A text field keeps its own native undo —
   * taking that over would make retyping an amount impossible.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      if (key === "y" || event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  /**
   * The deepest legal seat for a block, or null when it does not fit at all.
   *
   * Searched from the bottom up so a tap appends rather than splices: dropping
   * a swap into the middle of a finished chain would silently rewrite what the
   * blocks below it receive, where adding to the end only ever extends.
   */
  const bestIndexFor = useCallback(
    (block: LegoBlock): number | null => {
      for (let index = chain.length; index >= 0; index--) {
        if (canInsert(chain, block, index)) return index;
      }
      return null;
    },
    [chain],
  );

  /**
   * Which palette blocks seat anywhere in the current chain, worked out once.
   *
   * This drives the dimming on all two dozen chips, and it only depends on the
   * chain — but it used to be recomputed inline during render, and a drag
   * re-renders on every single `pointermove`. That meant two dozen seating
   * searches, each scanning every position in the chain, for every pixel the
   * pointer travelled, to arrive at exactly the answer from the frame before.
   * Keyed on the chain, so it recomputes when the answer can actually change.
   */
  const fitsById = useMemo(
    () => new Map(BLOCKS.map((block) => [block.id, bestIndexFor(block) !== null])),
    [bestIndexFor],
  );

  const insertBlock = useCallback(
    (blockId: string, index: number): void => {
      const uid = nextUid();
      const next = [...chain];
      next.splice(index, 0, makeNode(blockId, uid));
      commit(next);
      setOpenUid(uid);
      announce(`${getBlock(blockId)?.name ?? blockId} added at position ${index + 1} of ${next.length}.`);
      trackEvent("builder_block_added", { block: blockId });
    },
    [announce, chain, commit],
  );

  const addBlock = useCallback(
    (block: LegoBlock): void => {
      const index = bestIndexFor(block);
      if (index === null) {
        flash(
          block.kind === "source"
            ? "A chain starts from exactly one source — remove the current one first."
            : `${block.name} needs ${block.accepts ? SHAPE_LABEL[block.accepts] : "a source"} above it. Add the block that produces it.`,
        );
        return;
      }
      insertBlock(block.id, index);
    },
    [bestIndexFor, flash, insertBlock],
  );

  const removeNode = useCallback(
    (uid: string): void => {
      const next = chain.filter((node) => node.uid !== uid);
      const name = getBlock(chain.find((node) => node.uid === uid)?.blockId ?? "")?.name ?? "Block";
      commit(next);
      setOpenUid((current) => (current === uid ? null : current));
      announce(next.length ? `${name} removed. ${next.length} blocks left.` : `${name} removed. The canvas is empty.`);
    },
    [announce, chain, commit],
  );

  /**
   * Whether nudging a block one step would still seat.
   *
   * The arrow buttons are the keyboard route to the same rearranging drag does,
   * so they answer to the same connector rule — otherwise the accessible path
   * would be the only one that can assemble a chain the compiler rejects.
   */
  const canMove = useCallback(
    (uid: string, delta: number): boolean => {
      const from = chain.findIndex((node) => node.uid === uid);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= chain.length) return false;
      const block = getBlock(chain[from].blockId);
      if (!block) return false;
      return canInsert(
        chain.filter((node) => node.uid !== uid),
        block,
        to,
      );
    },
    [chain],
  );

  const moveNode = useCallback(
    (uid: string, delta: number): void => {
      if (!canMove(uid, delta)) return;
      const from = chain.findIndex((node) => node.uid === uid);
      const next = [...chain];
      const [node] = next.splice(from, 1);
      next.splice(from + delta, 0, node);
      commit(next);
      announce(
        `${getBlock(node.blockId)?.name ?? "Block"} moved ${delta < 0 ? "up" : "down"} to position ${
          from + delta + 1
        } of ${next.length}.`,
      );
    },
    [announce, canMove, chain, commit],
  );

  const setParam = useCallback(
    (uid: string, key: string, value: ParamValue): void => {
      commit(
        chain.map((node) => (node.uid === uid ? { ...node, params: { ...node.params, [key]: value } } : node)),
        "",
        `param:${uid}:${key}`,
      );
    },
    [chain, commit],
  );

  /**
   * Copy a placed block, settings and all, directly below itself.
   *
   * Routed through `canInsert` like every other placement: a second source, or
   * a second copy of a block whose shape only seats once, would otherwise be
   * the one way to assemble a chain the compiler rejects.
   */
  const duplicateNode = useCallback(
    (uid: string): void => {
      const index = chain.findIndex((node) => node.uid === uid);
      if (index < 0) return;
      const node = chain[index];
      const block = getBlock(node.blockId);
      if (!block) return;
      if (!canInsert(chain, block, index + 1)) {
        flash(`A second ${block.name} does not seat below this one.`);
        return;
      }
      const copy = makeNode(node.blockId, nextUid(), node.params);
      const next = [...chain];
      next.splice(index + 1, 0, copy);
      commit(next);
      setOpenUid(copy.uid);
      announce(`${block.name} duplicated at position ${index + 2} of ${next.length}.`);
      trackEvent("builder_block_duplicated", { block: block.id });
    },
    [announce, chain, commit, flash],
  );

  /** Scroll a block into view, open it, and flag it briefly. */
  const revealNode = useCallback((uid: string): void => {
    setOpenUid(uid);
    setFlaggedUid(uid);
    cardRefs.current.get(uid)?.scrollIntoView({
      behavior: reducedMotionEnabled() ? "auto" : "smooth",
      block: "center",
    });
    window.clearTimeout(flagTimer.current);
    flagTimer.current = window.setTimeout(() => setFlaggedUid(null), FLAG_MS);
  }, []);

  const loadRecipe = useCallback(
    (recipe: ZapRecipe): void => {
      commit(nodesFromRecipe(recipe), recipe.id);
      setOpenUid(null);
      announce(`Loaded the ${recipe.name} blueprint: ${recipe.blocks.length} blocks.`);
      trackEvent("builder_recipe_loaded", { recipe: recipe.id });
    },
    [announce, commit],
  );

  // ---- drag and drop -------------------------------------------------------
  // Pointer events rather than HTML5 drag-and-drop: the native API has no touch
  // implementation at all, so a phone would be left with no way to compose a
  // chain. One code path now covers mouse, pen, and finger.

  /**
   * Where in the chain a held block would land.
   *
   * The track is a wrapping row, so a single vertical midpoint no longer says
   * which side of a node the pointer is on. This walks the placements in
   * reading order and stops at the first one the pointer is *before* — above
   * its row, or left of its centre within that row. In a one-column layout
   * (a phone, or a chain that has not wrapped) the `x` test never fires and it
   * degenerates to exactly the vertical midpoint rule it replaces.
   */
  const resolveDrop = useCallback(
    (state: DragState, x: number, y: number): { index: number | null; valid: boolean } => {
      const track = canvasRef.current;
      if (!track) return { index: null, valid: false };
      const bounds = track.getBoundingClientRect();
      // A generous margin: on a phone the chain fills the screen and the finger
      // regularly strays past the panel edge mid-drag.
      if (y < bounds.top - 120 || y > bounds.bottom + 120) return { index: null, valid: false };
      if (x < bounds.left - 120 || x > bounds.right + 120) return { index: null, valid: false };

      const working = state.from === "chain" ? chain.filter((node) => node.uid !== state.uid) : chain;

      let index = working.length;
      for (let i = 0; i < working.length; i++) {
        const el = cardRefs.current.get(working[i].uid);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)) {
          index = i;
          break;
        }
      }

      const block = getBlock(state.blockId);
      return { index, valid: Boolean(block) && canInsert(working, block as LegoBlock, index) };
    },
    [chain],
  );

  const dragActive = drag?.active === true;

  /**
   * Scroll the workspace while a block is held against its edge.
   *
   * Driven by animation frames rather than by pointer movement, because the
   * gesture that needs this most is a finger parked at the bottom of the screen
   * — which emits no `pointermove` at all. Each frame that actually scrolls
   * re-resolves the drop: the pointer has not moved, but every card under it
   * has. The pointer position is read from the ref rather than from `drag`, so
   * the loop is set up once per gesture instead of once per pixel travelled.
   *
   * The scroll lives on the app shell's `#zapscroll` container, not the window.
   * Scrolling the window here is a silent no-op — nothing would error, dragging
   * to the end of a long chain would simply stop working.
   */
  useEffect(() => {
    if (!dragActive) return;
    let frame = window.requestAnimationFrame(function step(): void {
      const state = dragRef.current;
      if (state?.active) {
        const scroller = document.getElementById("zapscroll");
        const rect = scroller?.getBoundingClientRect();
        const delta = edgeScrollDelta(state.y - (rect?.top ?? 0), rect?.height ?? window.innerHeight);
        if (delta !== 0) {
          const before = scroller ? scroller.scrollTop : window.scrollY;
          if (scroller) scroller.scrollBy(0, delta);
          else window.scrollBy(0, delta);
          // At either end `scrollBy` is a no-op, and re-resolving a drop that
          // cannot have moved would churn state every frame for as long as the
          // block is held there.
          const after = scroller ? scroller.scrollTop : window.scrollY;
          if (after !== before) {
            const drop = resolveDrop(state, state.x, state.y);
            setDropIndex(drop.index);
            setDropValid(drop.valid);
          }
        }
      }
      frame = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dragActive, resolveDrop]);

  const beginDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, origin: DragOrigin): void => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.setPointerCapture(event.pointerId);
      stopRun();
      const state: DragState = {
        ...origin,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        width: rect.width,
        active: false,
      };
      // The ref is what the gesture actually reads; the state copy exists only
      // to paint the ghost. Keeping them separate means a pointerup that lands
      // before React has re-rendered still sees the drag it belongs to.
      dragRef.current = state;
      setDrag(state);
      setDropIndex(null);
      setDropValid(false);
    },
    [stopRun],
  );

  const onDragMove = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const travelled = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
      const next: DragState = {
        ...state,
        x: event.clientX,
        y: event.clientY,
        active: state.active || travelled > DRAG_THRESHOLD,
      };
      dragRef.current = next;
      setDrag(next);
      if (!next.active) return;
      const drop = resolveDrop(next, event.clientX, event.clientY);
      setDropIndex(drop.index);
      setDropValid(drop.valid);
    },
    [resolveDrop],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      setDropIndex(null);
      setDropValid(false);
      if (!state || state.pointerId !== event.pointerId) return;

      const block = getBlock(state.blockId);
      if (!block) return;

      // A press that never became a drag is a tap: treat it as "add this".
      if (!state.active) {
        if (state.from === "palette") addBlock(block);
        else setOpenUid((current) => (current === state.uid ? null : state.uid));
        return;
      }

      const drop = resolveDrop(state, event.clientX, event.clientY);
      if (drop.index === null || !drop.valid) {
        if (drop.index !== null) {
          flash(
            `${block.name} does not seat there — it takes ${block.accepts ? SHAPE_LABEL[block.accepts] : "no input"}.`,
          );
        }
        return;
      }

      if (state.from === "palette") {
        insertBlock(state.blockId, drop.index);
        return;
      }

      const node = chain.find((entry) => entry.uid === state.uid);
      if (!node) return;
      const next = chain.filter((entry) => entry.uid !== state.uid);
      next.splice(drop.index, 0, node);
      commit(next);
    },
    [addBlock, chain, commit, flash, insertBlock, resolveDrop],
  );

  const cancelDrag = useCallback((): void => {
    dragRef.current = null;
    setDrag(null);
    setDropIndex(null);
    setDropValid(false);
  }, []);

  // ---- run preview ---------------------------------------------------------

  const previewRun = useCallback((): void => {
    if (compiled.status === "block" || chain.length === 0) return;
    window.clearInterval(runTimer.current);
    const reduced = reducedMotionEnabled();
    if (reduced) {
      setRunIndex(chain.length - 1);
      runTimer.current = window.setTimeout(() => setRunIndex(-1), 900) as unknown as number;
      return;
    }
    let step = 0;
    setRunIndex(0);
    runTimer.current = window.setInterval(() => {
      step += 1;
      if (step >= chain.length) {
        window.clearInterval(runTimer.current);
        runTimer.current = undefined;
        setRunIndex(-1);
        return;
      }
      setRunIndex(step);
    }, 380);
    announce(`Previewing ${chain.length} step${chain.length === 1 ? "" : "s"} in order.`);
    trackEvent("builder_preview_run", { blocks: chain.length });
  }, [announce, chain.length, compiled.status]);

  const scrollRecipes = useCallback((direction: -1 | 1): void => {
    const row = recipeRowRef.current;
    if (!row) return;
    row.scrollBy({
      left: direction * Math.max(row.clientWidth * 0.72, 240),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);

  /**
   * The block the preview highlight is currently on.
   *
   * Read off the chain rather than out of `compiled.steps`, which only holds
   * entries for blocks the catalog still knows — one unrecognised placement and
   * every index after it would name the wrong card.
   */
  const runStep = useMemo(() => {
    const node = runIndex >= 0 ? chain[runIndex] : undefined;
    const block = node ? getBlock(node.blockId) : undefined;
    if (!node || !block) return null;
    return { position: runIndex + 1, name: block.name, summary: summarise(block, node) };
  }, [chain, runIndex]);

  /**
   * The palette, narrowed by search.
   *
   * The search reads the blurb and the category label as well as the name,
   * because the word someone reaches for is rarely the block's title: "dca"
   * finds the recurring deposit through its blurb, "borrow" finds the whole
   * lending group through its category.
   */
  const visibleBlocks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return BLOCKS;
    return BLOCKS.filter((block) =>
      `${block.name} ${block.blurb} ${CATEGORY_LABEL[block.category]}`.toLowerCase().includes(needle),
    );
  }, [query]);

  /** Standing headings, in catalog order, with the empty ones dropped. */
  const blockGroups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        blocks: visibleBlocks.filter((block) => block.category === category),
      })).filter((group) => group.blocks.length > 0),
    [visibleBlocks],
  );

  const exportPayload = useMemo(
    () =>
      JSON.stringify(
        {
          version: 1,
          // Not the onchain policy hash — see the fingerprint note in the
          // readout. Naming the field for what it is keeps a copied JSON from
          // being compared against a block explorer and read as a mismatch.
          designFingerprint: compiled.hash,
          status: compiled.status,
          gasEstimate: compiled.gas,
          guardCoverage: compiled.guardScore,
          steps: compiled.steps,
          chain: chain.map((node) => ({ block: node.blockId, params: node.params })),
        },
        null,
        2,
      ),
    [chain, compiled],
  );

  const shareUrl = useMemo(() => `${origin}/zap?${SHARE_PARAM}=${encodeChain(chain)}`, [chain, origin]);

  /** What, if anything, of this design the live v1.1 contracts can carry. */
  const deployment = useMemo(() => reduceChainToLiveRoute(chain), [chain]);
  /** A cadence or one-sided price condition the live automation stack can bind. */
  const automation = useMemo(() => reduceChainToAutomation(chain), [chain]);
  // `route` is the route identity `/app` resolves and signs; `dir` is kept only
  // for backward-compatibility with the bounded pair (older links carry it and
  // no route id). Amount is the decimal string in the token's own units.
  // `view=sign` flips the surface to the console in place. The established
  // route/amount/bps keys stay compatible; explicit gas controls are additive.
  const oneShotHandoffAllowed = !(automation.deployable && automation.mode === "trigger");
  let deployHref: string | null = null;
  if (deployment.deployable && oneShotHandoffAllowed) {
    const params = new URLSearchParams({
      view: "sign",
      src: "build",
      route: deployment.routeId,
      amount: deployment.amountIn,
      bps: String(deployment.slippageBps),
      maxGas: String(deployment.executionPolicy.maxGas),
      maxFeeGwei: String(deployment.executionPolicy.maxFeePerGasGwei),
    });
    if (deployment.direction) params.set("dir", deployment.direction);
    deployHref = `/zap?${params.toString()}`;
  }
  /** The resolved route the handoff would sign, for naming its tokens honestly. */
  const deployRoute = useMemo(
    () => (deployment.deployable ? resolveRouteById(deployment.routeId) : null),
    [deployment],
  );
  const automateHref = automation.deployable ? automationHandoff(automation) : null;
  const automationRoute = useMemo(
    () => (automation.deployable ? resolveRouteById(automation.routeId) : null),
    [automation],
  );

  const executionPolicyResolution = useMemo(() => resolveExecutionPolicy(chain), [chain]);
  const executionPolicy = executionPolicyResolution.ok
    ? executionPolicyResolution.policy
    : DEFAULT_EXECUTION_POLICY;
  const missingExecutionPolicyIds = useMemo(
    () => EXECUTION_POLICY_BLOCK_IDS.filter((blockId) => !chain.some((node: ChainNode) => node.blockId === blockId)),
    [chain],
  );
  const composeExecutionPolicy = useCallback((): void => {
    const result = composeBlockStack(chain, missingExecutionPolicyIds, nextUid);
    if (result.added.length === 0) {
      flash(
        missingExecutionPolicyIds.length === 0
          ? "All three execution-policy blocks are already explicit."
          : "Add a source before composing the execution-policy stack.",
      );
      return;
    }
    commit(result.chain);
    setOpenUid(result.added[result.added.length - 1].uid);
    const names = result.added.map((node) => getBlock(node.blockId)?.name ?? node.blockId).join(", ");
    announce(`Composed ${result.added.length} execution-policy blocks as one edit: ${names}.`);
    trackEvent("builder_policy_stack_composed", { blocks: result.added.length });
  }, [announce, chain, commit, flash, missingExecutionPolicyIds]);

  // Feature 1: the builder now prices the route it is about to hand off, plus
  // the fixed native creation fee's atomic aeWETH -> 0xZAPS conversion. The
  // quote is indicative until the signing console refreshes it immediately
  // before execution, and every stale async response is epoch-discarded.
  const quoteRouteTarget = deployRoute ?? automationRoute;
  const quoteAmountText = deployment.deployable
    ? deployment.amountIn
    : automation.deployable
      ? automation.amountIn
      : "";
  const quoteSlippageBps = deployment.deployable
    ? deployment.slippageBps
    : automation.deployable
      ? automation.slippageBps
      : 0;
  const [builderQuote, setBuilderQuote] = useState<BuilderQuoteState>({ status: "idle" });
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const quoteEpoch = useRef(0);

  useEffect(() => {
    const epoch = ++quoteEpoch.current;
    if (!quoteRouteTarget || !quoteAmountText || !CREATION_FEE_ROUTE) {
      const timer = window.setTimeout(() => {
        if (quoteEpoch.current === epoch) setBuilderQuote({ status: "idle" });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setBuilderQuote({ status: "loading" });
      let amountIn: bigint;
      try {
        amountIn = parseRouterAmount(quoteAmountText, quoteRouteTarget.tokenIn.decimals);
      } catch (cause) {
        setBuilderQuote({ status: "error", message: cause instanceof Error ? cause.message : "Invalid amount." });
        return;
      }
      void Promise.all([
        quoteRoute(builderClient, quoteRouteTarget, amountIn, zeroAddress),
        quoteRoute(builderClient, CREATION_FEE_ROUTE, OPENZAP_CREATION_FEE, zeroAddress),
      ]).then(
        ([routeQuote, feeQuote]) => {
          if (quoteEpoch.current !== epoch) return;
          setBuilderQuote({
            status: "ready",
            amountOut: routeQuote.amountOut,
            feeZapsOut: feeQuote.amountOut,
            routeId: quoteRouteTarget.id,
          });
        },
        (cause: unknown) => {
          if (quoteEpoch.current !== epoch) return;
          setBuilderQuote({
            status: "error",
            message: cause instanceof Error ? cause.message : "Live quote unavailable.",
          });
        },
      );
    }, 320);
    return () => window.clearTimeout(timer);
  }, [quoteAmountText, quoteRefresh, quoteRouteTarget]);

  const quoteEconomics =
    builderQuote.status === "ready"
      ? builderQuoteEconomics(
          builderQuote.amountOut,
          quoteSlippageBps,
          automation.deployable ? automation.mode : null,
        )
      : null;

  /**
   * The settings panel's view of the chain: the source block's amount and the
   * first slippage guard's cap, flattened so the inputs can bind to them
   * directly. Derived from the chain and written back with `setParam`, so
   * there is exactly one copy of every number.
   */
  const settingsAmount = useMemo(() => {
    for (const node of chain) {
      const block = getBlock(node.blockId);
      if (block?.kind !== "source") continue;
      const param = block.params.find((candidate) => candidate.key === "amount");
      // A source without an amount (pending rewards draws whatever accrued) is
      // still a source — say that, never "no source".
      if (!param) return { kind: "unparameterised" as const, name: block.name };
      return {
        kind: "amount" as const,
        uid: node.uid,
        label: param.label,
        asset: String(node.params.asset ?? ""),
        value: String(node.params.amount ?? param.value),
      };
    }
    return null;
  }, [chain]);

  const settingsSlippage = useMemo(() => {
    // The TIGHTEST cap governs the deploy reduction, so that is the guard the
    // panel must edit — pointing the slider at whichever guard happened to be
    // first would show a number that never reaches the signed policy.
    let tightest: { uid: string; bps: number; min?: number; max?: number; step?: number } | null = null;
    for (const node of chain) {
      if (node.blockId !== "guard-slippage") continue;
      const param = getBlock(node.blockId)?.params.find((candidate) => candidate.key === "bps");
      if (!param || param.type !== "number") continue;
      const bps = Number(node.params.bps ?? param.value);
      if (!tightest || bps < tightest.bps) {
        tightest = { uid: node.uid, bps, min: param.min, max: param.max, step: param.step };
      }
    }
    return tightest;
  }, [chain]);

  /**
   * Load a design pasted as a share link or a copied JSON export.
   *
   * Importing goes through `commit`, so it lands on the undo stack like any
   * other edit — pasting the wrong thing over a chain you were working on is
   * one press of ⌘Z, not a lost afternoon.
   */
  const importDesign = useCallback((): void => {
    const nodes = decodeDesign(importText);
    if (!nodes) {
      flash("That is not a design. Paste a /zap share link (old /build links work too) or the JSON from “Copy design JSON”.");
      return;
    }
    advancePlacementCounter(nodes);
    commit(nodes);
    setOpenUid(null);
    setImportText("");
    setImporting(false);
    const loaded = `Loaded ${nodes.length} block${nodes.length === 1 ? "" : "s"}. ⌘Z puts your previous chain back.`;
    flash(loaded);
    announce(loaded);
    trackEvent("builder_design_imported", { blocks: nodes.length });
  }, [announce, commit, flash, importText]);

  const saveDesign = useCallback((): void => {
    // The draft already persists on every edit; this is the explicit route for
    // a chain that arrived from a share link or a blueprint and has not been
    // touched, which would otherwise never have been written.
    setEdited({ chain, recipeId });
    setSavedChain(chain);
    trackEvent("builder_design_saved", { blocks: chain.length });
  }, [chain, recipeId]);

  /* ---- the design library: named, durable saves beside the one draft ---- */

  // null until mounted: the server renders no library, so hydration agrees.
  const [library, setLibrary] = useState<SavedDesign[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [libraryName, setLibraryName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setLibrary(readDesignLibrary());
    return () => window.clearTimeout(confirmTimer.current);
  }, []);

  const persistLibrary = useCallback((next: SavedDesign[]): void => {
    setLibrary(next);
    writeDesignLibrary(next);
  }, []);

  const saveToLibrary = useCallback((): void => {
    if (!library) return;
    const result = upsertDesign(library, {
      name: libraryName,
      chain,
      now: Date.now(),
      id: crypto.randomUUID(),
    });
    if (!result.ok) {
      flash(result.reason);
      return;
    }
    persistLibrary(result.list);
    setNaming(false);
    setLibraryName("");
    const message = result.replaced
      ? `Updated “${result.saved.name}” in your library.`
      : `Saved “${result.saved.name}” to your library.`;
    flash(message);
    announce(message);
    trackEvent("builder_library_saved", { blocks: chain.length, replaced: result.replaced });
  }, [announce, chain, flash, library, libraryName, persistLibrary]);

  const loadSavedDesign = useCallback(
    (design: SavedDesign): void => {
      const nodes = decodeSavedDesign(design);
      if (!nodes) {
        // A token can stop decoding when the catalog retires a block; the
        // entry stays put so the name still tells the user what it was.
        flash(`“${design.name}” no longer decodes against today's catalog.`);
        return;
      }
      advancePlacementCounter(nodes);
      commit(nodes);
      setOpenUid(null);
      const message = `Loaded “${design.name}”: ${nodes.length} blocks. ⌘Z puts your previous chain back.`;
      flash(message);
      announce(message);
      trackEvent("builder_library_loaded", { blocks: nodes.length });
    },
    [announce, commit, flash],
  );

  const confirmRename = useCallback((): void => {
    if (!library || !renamingId) return;
    const result = renameDesign(library, renamingId, renameText, Date.now());
    if (!result.ok) {
      flash(result.reason);
      return;
    }
    persistLibrary(result.list);
    setRenamingId(null);
    setRenameText("");
    announce(`Renamed to “${result.saved.name}”.`);
  }, [announce, flash, library, persistLibrary, renameText, renamingId]);

  const deleteSavedDesign = useCallback(
    (design: SavedDesign): void => {
      if (!library) return;
      if (confirmDeleteId !== design.id) {
        // Two presses on the same control: deleting is the one library action
        // undo cannot reach, so it does not fire on a stray click.
        setConfirmDeleteId(design.id);
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(() => setConfirmDeleteId(null), 4000);
        return;
      }
      window.clearTimeout(confirmTimer.current);
      setConfirmDeleteId(null);
      persistLibrary(removeDesign(library, design.id));
      const message = `Deleted “${design.name}” from your library.`;
      flash(message);
      announce(message);
      trackEvent("builder_library_deleted", { blocks: design.blocks });
    },
    [announce, confirmDeleteId, flash, library, persistLibrary],
  );

  const dragBlock = drag ? getBlock(drag.blockId) : undefined;

  // ---- readout summaries ---------------------------------------------------
  // Compile validity and live-route deployability are different facts. A design
  // can compile perfectly and still have nothing on Robinhood Chain to run it,
  // so the chip never claims "deployable" from `compiled.status` alone.
  const jointCount = compiled.joints.length;
  const seatedJoints = compiled.joints.filter((joint) => joint.status === "ok").length;
  const allSeated = jointCount > 0 && seatedJoints === jointCount;
  const verdict: { label: string; tone: "ok" | "warn" | "danger" } =
    compiled.status === "block"
      ? { label: "blocked", tone: "danger" }
      : compiled.status === "warn"
        ? { label: "review", tone: "warn" }
        : deployment.deployable
          ? { label: "deployable", tone: "ok" }
          : { label: "compiles", tone: "ok" };

  const handoffAvailable = Boolean((deployment.deployable && deployHref) || (automation.deployable && automateHref));

  return (
    <div className={styles.screen} data-dragging={drag?.active ? "true" : "false"}>
      <section className={styles.reuse} aria-label="Zap blueprints">
        <div className={styles.reuseHead}>
          <div>
            <h2 className={styles.reuseTitle}>Start from a blueprint</h2>
            {/* No count in the copy: it went stale the first time a blueprint was
                added, and the row is right there to be counted. */}
            <p className={styles.reuseLede}>
              Choose an outcome, then inspect every block. <em>Deployable</em> routes can Zap now;{" "}
              <em>automatable</em> designs bind a cadence or price condition on the live aeWETH ↔ 0xZAPS stack.
            </p>
          </div>
          <div className={styles.reuseNav} aria-label="Browse blueprints">
            <button
              type="button"
              className={styles.reuseNavBtn}
              onClick={() => scrollRecipes(-1)}
              aria-label="Previous blueprints"
            >
              <BlockGlyph name="chevronLeft" />
            </button>
            <button
              type="button"
              className={styles.reuseNavBtn}
              onClick={() => scrollRecipes(1)}
              aria-label="Next blueprints"
            >
              <BlockGlyph name="chevronRight" />
            </button>
          </div>
        </div>
        <div className={styles.reuseRow} ref={recipeRowRef}>
          {RECIPES.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className={styles.blueprint}
              data-active={recipe.id === recipeId}
              aria-pressed={recipe.id === recipeId}
              style={{ ["--accent" as string]: SHAPE_COLOR[recipe.accent] }}
              onClick={() => loadRecipe(recipe)}
            >
              <strong>{recipe.name}</strong>
              <span>{recipe.tagline}</span>
              <em>
                {recipe.blocks.length} blocks
                {DEPLOYABLE_RECIPES.has(recipe.id) ? <i className={styles.tagOk}>deployable</i> : null}
                {AUTOMATABLE_RECIPES.has(recipe.id) ? <i className={styles.tagInfo}>automatable</i> : null}
              </em>
            </button>
          ))}
        </div>
      </section>

      {library && library.length > 0 ? (
        <section className={styles.reuse} aria-label="Your saved designs">
          <div className={styles.reuseHead}>
            <div>
              <h2 className={styles.reuseTitle}>Your designs</h2>
              <p className={styles.reuseLede}>
                Saved on this device — {library.length} of {MAX_SAVED_DESIGNS}. Loading one lands on the
                undo stack like any other edit; the share link reopens it anywhere.
              </p>
            </div>
          </div>
          <div className={styles.reuseRow}>
            {library.map((design) => (
              <div
                key={design.id}
                className={`${styles.blueprint} ${styles.savedCard}`}
                style={{ ["--accent" as string]: SHAPE_COLOR[design.accent] }}
              >
                {renamingId === design.id ? (
                  <div className={styles.savedRename}>
                    <input
                      className={styles.textInput}
                      value={renameText}
                      autoFocus
                      maxLength={MAX_DESIGN_NAME}
                      aria-label={`New name for ${design.name}`}
                      onChange={(event) => setRenameText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") confirmRename();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                    <button
                      type="button"
                      className={`${styles.toolBtn} ${styles.toolBtnLg}`}
                      onClick={confirmRename}
                      disabled={!renameText.trim()}
                    >
                      Rename
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.savedLoad}
                    onClick={() => loadSavedDesign(design)}
                  >
                    <strong>{design.name}</strong>
                    <em>
                      {design.blocks} blocks · settles as {SHAPE_LABEL[design.accent]}
                    </em>
                  </button>
                )}
                <div className={styles.savedControls}>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(design.id);
                      setRenameText(design.name);
                      setConfirmDeleteId(null);
                    }}
                  >
                    Rename
                  </button>
                  <CopyButton
                    value={`${origin}/zap?${SHARE_PARAM}=${design.token}`}
                    label="Link"
                    title={`Copy a share link that reopens “${design.name}”`}
                  />
                  <button
                    type="button"
                    data-danger
                    aria-label={
                      confirmDeleteId === design.id
                        ? `Press again to delete ${design.name}`
                        : `Delete ${design.name}`
                    }
                    onClick={() => deleteSavedDesign(design)}
                  >
                    {confirmDeleteId === design.id ? "Sure?" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.workspace}>
        {/* ---- palette ---- */}
        <aside className={styles.palette} aria-label="Block palette">
          <div className={styles.paletteHead}>
            <h2>Blocks</h2>
          </div>
          <div className={styles.paletteSearch}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Search blocks"
              aria-label="Search blocks by name, description, or category"
            />
          </div>
          <div className={styles.paletteScroll}>
            {visibleBlocks.length === 0 ? (
              <p className={styles.noMatch} role="status">
                No block matches “{query.trim()}”.
              </p>
            ) : null}
            {blockGroups.map((group) => (
              <Fragment key={group.category}>
                <span className={styles.paletteGroup}>{CATEGORY_LABEL[group.category].toUpperCase()}</span>
                {group.blocks.map((block) => {
                  const fits = fitsById.get(block.id) ?? false;
                  // The button's aria-label REPLACES its contents in the
                  // accessible name, so the blurb and the venue marks must be
                  // said here or a screen reader never hears them — the row
                  // itself is one line now.
                  const chipProtocols = protocolsForAction(block.id, defaultParams(block));
                  const chipVia = chipProtocols.length
                    ? ` Routes through ${chipProtocols.map((protocol) => protocol.name).join(" and ")}.`
                    : "";
                  return (
                    <button
                      key={block.id}
                      type="button"
                      className={styles.block}
                      data-fits={fits}
                      data-kind={block.kind}
                      data-lifted={drag?.from === "palette" && drag.blockId === block.id && drag.active}
                      title={block.blurb}
                      onPointerDown={(event) => beginDrag(event, { from: "palette", blockId: block.id })}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                      onPointerCancel={cancelDrag}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        addBlock(block);
                      }}
                      aria-label={`${block.name}. ${block.blurb}${chipVia} ${fits ? "Fits the current chain." : "Does not fit the current chain yet."}`}
                    >
                      <BlockGlyph name={block.glyph} className={styles.blockGlyph} />
                      <span className={styles.blockName}>{block.name}</span>
                      <span className={styles.blockPorts} aria-hidden>
                        {block.accepts ? <i style={{ background: SHAPE_COLOR[block.accepts] }} /> : null}
                        {block.emits ? <i style={{ background: SHAPE_COLOR[block.emits] }} /> : null}
                      </span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
          {/* The key for every port dot above and every connector on the canvas. */}
          <div className={styles.paletteLegend}>
            {SHAPES.map((shape) => (
              <span key={shape}>
                <i style={{ background: SHAPE_COLOR[shape] }} />
                {SHAPE_LABEL[shape]}
              </span>
            ))}
          </div>
        </aside>

        {/* ---- canvas ---- */}
        <section className={styles.canvas} aria-label="Zap chain">
          <div className={styles.canvasBar}>
            <span className={styles.canvasCount} title={GAS_ESTIMATE_NOTE}>
              {chain.length} block{chain.length === 1 ? "" : "s"} · ≈{compiled.gas.toLocaleString("en-US")} gas
            </span>
            <div className={styles.canvasTools}>
              <button
                type="button"
                className={`${styles.toolBtn} ${styles.toolIcon}`}
                onClick={undo}
                disabled={past.length === 0}
                aria-label="Undo"
                aria-keyshortcuts="Control+Z Meta+Z"
                title="Undo (⌘Z)"
              >
                ↶
              </button>
              <button
                type="button"
                className={`${styles.toolBtn} ${styles.toolIcon}`}
                onClick={redo}
                disabled={future.length === 0}
                aria-label="Redo"
                aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                title="Redo (⇧⌘Z)"
              >
                ↷
              </button>
              <button
                type="button"
                className={styles.toolBtn}
                onClick={previewRun}
                disabled={compiled.status === "block" || !chain.length}
              >
                Preview Zap
              </button>
              <button
                type="button"
                className={styles.toolBtn}
                onClick={() => {
                  commit([]);
                  setOpenUid(null);
                  announce("Canvas cleared. Undo puts it back.");
                }}
                disabled={!chain.length}
                title="Clear the canvas — ⌘Z brings it back"
              >
                Clear
              </button>
            </div>
          </div>

          <div className={styles.canvasBody}>
            {/* The drag target is the track itself, and it is rendered even when
                empty: the resolver hit-tests against this box, so losing it
                would silently disable dropping into an empty canvas. */}
            <div className={styles.track} ref={canvasRef}>
              {chain.length === 0 ? (
                <div className={styles.empty} data-over={dropIndex === 0}>
                  <BlockGlyph name="wallet" className={styles.emptyGlyph} />
                  <strong>Drop a source here</strong>
                  <span>Every chain starts with one — a wallet balance, a recurring deposit, or pending rewards.</span>
                </div>
              ) : null}

              {chain.map((node, index) => {
                const block = getBlock(node.blockId);
                if (!block) return null;
                const joint = compiled.joints[index];
                const open = openUid === node.uid;
                const incoming = joint?.shape ?? null;
                const brokenJoint = joint?.status === "mismatch" || joint?.status === "orphan";
                const lifted = drag?.from === "chain" && drag.uid === node.uid && drag.active;
                const previousOpen = index > 0 && openUid === chain[index - 1]?.uid;

                return (
                  <Fragment key={node.uid}>
                    <div
                      className={styles.slot}
                      data-open={drag?.active && dropIndex === index}
                      data-valid={dropValid}
                      aria-hidden
                    >
                      <span />
                    </div>

                    {index > 0 ? (
                      <div
                        className={styles.connector}
                        data-status={joint?.status ?? "ok"}
                        data-flowing={runIndex >= index}
                        data-mirror={previousOpen ? "true" : "false"}
                        title={
                          brokenJoint ? "does not fit" : incoming ? SHAPE_LABEL[incoming] : "start"
                        }
                      >
                        <i className={styles.connectorLine} />
                        <i className={styles.connectorDot} />
                        {brokenJoint ? <span className={styles.connectorFlag}>does not fit</span> : null}
                      </div>
                    ) : null}

                    <article
                      ref={(el) => {
                        if (el) cardRefs.current.set(node.uid, el);
                        else cardRefs.current.delete(node.uid);
                      }}
                      className={styles.node}
                      data-kind={block.kind}
                      data-open={open}
                      data-lifted={lifted}
                      data-broken={brokenJoint}
                      data-running={runIndex === index}
                      data-flagged={flaggedUid === node.uid}
                    >
                      <span className={styles.nodeEyebrow}>
                        <span
                          className={styles.nodeHandle}
                          role="button"
                          tabIndex={-1}
                          aria-hidden
                          onPointerDown={(event) =>
                            beginDrag(event, { from: "chain", blockId: block.id, uid: node.uid, index })
                          }
                          onPointerMove={onDragMove}
                          onPointerUp={endDrag}
                          onPointerCancel={cancelDrag}
                        >
                          <BlockGlyph name={block.glyph} />
                        </span>
                        {eyebrowFor(block)}
                      </span>

                      <button
                        type="button"
                        className={styles.nodeTitle}
                        aria-expanded={open}
                        onClick={() => setOpenUid(open ? null : node.uid)}
                      >
                        <strong className={styles.nodeName}>{block.name}</strong>
                        <span className={styles.nodeValue}>{summarise(block, node)}</span>
                      </button>

                      <span className={styles.nodeChip} data-level={block.maturity}>
                        {block.maturity}
                      </span>

                      <span className={styles.nodeTools}>
                        <button
                          type="button"
                          onClick={() => moveNode(node.uid, -1)}
                          disabled={!canMove(node.uid, -1)}
                          aria-label={`Move ${block.name} up`}
                        >
                          <BlockGlyph name="chevronUp" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveNode(node.uid, 1)}
                          disabled={!canMove(node.uid, 1)}
                          aria-label={`Move ${block.name} down`}
                        >
                          <BlockGlyph name="chevronDown" />
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateNode(node.uid)}
                          disabled={!canInsert(chain, block, index + 1)}
                          aria-label={`Duplicate ${block.name}`}
                          title={`Duplicate ${block.name} with these settings`}
                        >
                          <BlockGlyph name="copy" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeNode(node.uid)}
                          aria-label={`Remove ${block.name}`}
                        >
                          <BlockGlyph name="trash" />
                        </button>
                      </span>

                      {open ? (
                        <div className={styles.nodeBody}>
                          <p className={styles.nodeDetail}>{block.detail}</p>
                          {/* The protocols this block actually calls under the
                              hood, with the block's CURRENT params — flip the
                              swap venue and the mark flips with it. */}
                          <ProtocolStack protocols={protocolsForAction(block.id, node.params)} size={17} />
                          {block.params.length ? (
                            <div className={styles.fields}>
                              {block.params.map((param) => {
                                const id = `${node.uid}-${param.key}`;
                                const value = node.params[param.key] ?? param.value;
                                return (
                                  <label key={param.key} className={styles.field} htmlFor={id}>
                                    <span className={styles.fieldLabel}>
                                      {param.label}
                                      {param.type === "number" ? (
                                        <em>
                                          {value}
                                          {paramSuffix(param)}
                                        </em>
                                      ) : param.type === "amount" && param.unit ? (
                                        // The figure is already in the field, so only the
                                        // unit needs saying — an amount is not a slider.
                                        <em>{param.unit}</em>
                                      ) : null}
                                    </span>
                                    {param.type === "number" ? (
                                      <input
                                        id={id}
                                        className={styles.range}
                                        type="range"
                                        min={param.min}
                                        max={param.max}
                                        step={param.step}
                                        value={Number(value)}
                                        onChange={(event) => setParam(node.uid, param.key, Number(event.target.value))}
                                      />
                                    ) : param.type === "amount" ? (
                                      <input
                                        id={id}
                                        className={styles.textInput}
                                        type="text"
                                        inputMode="decimal"
                                        // Never Number() this: the decimal text is what
                                        // `parseRouterAmount` turns into wei, and a float
                                        // round-trip would quietly drop the low digits.
                                        value={String(value)}
                                        placeholder={param.placeholder}
                                        onChange={(event) => setParam(node.uid, param.key, event.target.value)}
                                      />
                                    ) : param.type === "select" ? (
                                      <select
                                        id={id}
                                        className={styles.selectInput}
                                        value={String(value)}
                                        onChange={(event) => setParam(node.uid, param.key, event.target.value)}
                                      >
                                        {param.options.map((option) => (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <input
                                        id={id}
                                        className={styles.textInput}
                                        type="text"
                                        value={String(value)}
                                        placeholder={param.placeholder}
                                        onChange={(event) => setParam(node.uid, param.key, event.target.value)}
                                      />
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  </Fragment>
                );
              })}

              <div
                className={styles.slot}
                data-open={drag?.active && dropIndex === chain.length && chain.length > 0}
                data-valid={dropValid}
                aria-hidden
              >
                <span />
              </div>
            </div>

            <div className={styles.drop} aria-hidden>
              <i className={styles.dropRule} />
            </div>

            {/* A derived readout of what the chain already says, not a second
                drop target: guards live in the one node track, so drag, undo and
                `canInsert` all keep a single index space. */}
            <section className={styles.policy} aria-label="Execution policy stack">
              <div className={styles.policyHead}>
                <BlockGlyph name="lock" />
                <strong>Execution policy</strong>
                <span className={styles.policyHint}>added as one stack · undo removes all three</span>
                <button
                  type="button"
                  className={styles.policyCompose}
                  onClick={composeExecutionPolicy}
                  disabled={missingExecutionPolicyIds.length === 0}
                >
                  {missingExecutionPolicyIds.length === 0
                    ? "All three explicit ✓"
                    : missingExecutionPolicyIds.length === EXECUTION_POLICY_BLOCK_IDS.length
                      ? `Compose all ${EXECUTION_POLICY_BLOCK_IDS.length} policy blocks`
                      : `Compose remaining ${missingExecutionPolicyIds.length}`}
                </button>
                {/* v3.1 enforcement is an automation fact. A one-shot design gets
                    the same bounds signed into a single intent — saying "enforced
                    by v3.1" there would name a contract it never reaches. */}
                <span className={styles.pill} data-tone={automation.deployable ? "ok" : undefined}>
                  {automation.deployable ? "enforced by v3.1" : "one-shot bounds"}
                </span>
              </div>
              <div className={styles.policyCells}>
                <div>
                  <span>SLIPPAGE CAP</span>
                  <strong className={styles.mono}>{settingsSlippage?.bps ?? DEFAULT_SLIPPAGE_BPS} bps</strong>
                </div>
                <div>
                  <span>GAS CEILING</span>
                  <strong className={styles.mono}>
                    {executionPolicy.maxGas.toLocaleString("en-US")} · ≤{executionPolicy.maxFeePerGasGwei} gwei
                  </strong>
                </div>
                <div>
                  <span>EXECUTOR ACCESS</span>
                  <strong>{executionPolicy.executorAccess === "owner-only" ? "Owner only" : "Anyone"}</strong>
                </div>
              </div>
              <p className={styles.policyNote}>
                Gas caps bind both one-shot and automated EIP-712 intents. Executor access binds v3/v3.1 automation;
                Zap now discloses an owner-only choice because v1.1 cannot restrict its caller. Missing blocks use the
                protocol defaults shown here.
              </p>
            </section>

            <p className={styles.canvasNote}>
              Drag a block from the left to add it. Anything the selected contract cannot enforce is flagged before
              you hand off.
            </p>

            {/* What the highlight travelling along the row is actually on.
                Without this, "Preview Zap" lit each node in turn and said
                nothing — the animation showed the order, which the row already
                shows, and the settings it would execute with stayed inside
                whichever node happened to be open. */}
            {runStep ? (
              <p className={styles.runStep}>
                <span>
                  Step {runStep.position} of {chain.length}
                </span>
                <strong>{runStep.name}</strong>
                <em>{runStep.summary}</em>
              </p>
            ) : null}

            {hint ? (
              <p className={styles.hint} role="status">
                {hint}
              </p>
            ) : null}

            {/* Structural edits are visible as a card moving and audible as
                nothing. Polite, so it waits its turn rather than cutting across
                whatever the reader is already saying. */}
            <p className={styles.srStatus} role="status" aria-live="polite">
              {narration}
            </p>
          </div>
        </section>

        {/* ---- readout rail ---- */}
        <aside className={styles.rail} aria-label="Policy readout">
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Readout</h2>
              <span className={`${styles.pill} ${styles.pillEnd}`} data-tone={verdict.tone}>
                {verdict.label}
              </span>
            </div>
            <div className={styles.row}>
              <span>Blocks</span>
              <strong>
                {chain.length === 0
                  ? "empty canvas"
                  : `${chain.length} · ${allSeated ? "all connected" : `${jointCount - seatedJoints} not seated`}`}
              </strong>
            </div>
            <div className={styles.row}>
              <span>Connectors fit</span>
              <strong className={jointCount === 0 ? undefined : allSeated ? styles.ok : styles.danger}>
                {jointCount === 0 ? "none yet" : allSeated ? `all ${jointCount}` : `${seatedJoints} of ${jointCount}`}
              </strong>
            </div>
            <div className={styles.row}>
              <span>Guards enforced</span>
              <strong className={styles.mono}>{compiled.guardScore}%</strong>
            </div>
            <div className={styles.row}>
              <span>Est. gas</span>
              <strong className={styles.mono} title={GAS_ESTIMATE_NOTE}>
                ≈{compiled.gas.toLocaleString("en-US")}
              </strong>
            </div>
            <div className={styles.row}>
              <span>Creation fee</span>
              <strong className={styles.mono}>{formatBuilderToken(OPENZAP_CREATION_FEE, 18)} ETH</strong>
            </div>
          </section>

          <section className={`${styles.card} ${styles.handoff}`}>
            <h2>Hand it off</h2>
            <p className={styles.handoffLede}>The exact amount, floor, and bounds travel with it.</p>
            <div className={styles.handoffActions}>
              {deployment.deployable && deployHref ? (
                <Link
                  className={styles.zapBtn}
                  href={deployHref}
                  onClick={() => trackEvent("builder_deploy_handoff", { route: deployment.routeId })}
                >
                  <BlockGlyph name="boltFill" />
                  Zap now
                </Link>
              ) : null}
              {automation.deployable && automateHref ? (
                <Link
                  className={styles.ghostBtn}
                  href={automateHref}
                  onClick={() =>
                    trackEvent("builder_automate_handoff", { route: automation.routeId, mode: automation.mode })
                  }
                >
                  Automate it
                </Link>
              ) : null}
              {handoffAvailable ? null : (
                <button type="button" className={styles.primaryBtn} onClick={saveDesign}>
                  {savedChain === chain ? "Saved as design ✓" : "Save as design"}
                </button>
              )}
            </div>

            {handoffAvailable ? (
              <>
                {deployment.deployable ? (
                  <p className={styles.deployNote}>
                    <strong>Zap now</strong> opens with{" "}
                    {deployRoute
                      ? `${deployRoute.tokenIn.symbol} → ${deployRoute.tokenOut.symbol}`
                      : "the matching route"}
                    , {deployment.amountIn} {deployRoute ? deployRoute.tokenIn.symbol : ""}, a{" "}
                    {(deployment.slippageBps / 100).toFixed(2)}% signed slippage cap, up to{" "}
                    {deployment.executionPolicy.maxGas.toLocaleString("en-US")} gas, and at most{" "}
                    {deployment.executionPolicy.maxFeePerGasGwei} gwei. Creation, funding, and the final EIP-712
                    authorization stay in Zap now.
                  </p>
                ) : null}
                {automation.deployable ? (
                  <p className={styles.deployNote}>
                    <strong>{automation.mode === "recurring" ? "Recurring" : "Price-triggered"}</strong> handoff
                    preserves this route, amount, slippage,{" "}
                    {automation.executionPolicy.maxGas.toLocaleString("en-US")} gas, a{" "}
                    {automation.executionPolicy.maxFeePerGasGwei} gwei ceiling, and{" "}
                    {automation.executionPolicy.executorAccess === "owner-only"
                      ? "owner-only execution"
                      : "open execution"}
                    {automation.mode === "recurring"
                      ? `, then binds ${automation.maxRuns} runs on the ${automation.intervalId} cadence.`
                      : `, then binds ${automation.thresholdId.startsWith("up") ? "a rise" : "a fall"} of ${automation.thresholdId.replace(/\D/g, "")}% for ${automation.validDays} days.`}
                  </p>
                ) : null}
                {deployment.deployable && deployment.unenforcedGuards.length > 0 ? (
                  // Rendered in full, in the CTA's own line of sight. Summarising
                  // or counting these would let someone deploy believing a guard
                  // they drew is protecting funds that nothing is protecting.
                  <div className={styles.unenforced} role="note">
                    <strong>
                      If you Zap now, {deployment.unenforcedGuards.length} guard
                      {deployment.unenforcedGuards.length === 1 ? " in this design is" : "s in this design are"} not
                      enforced onchain.
                    </strong>
                    <p>
                      The one-shot policy binds owner, recipient, adapter, spender, input token, exact amount, and
                      minimum output. Choosing that path keeps those bounds and drops the rest:
                    </p>
                    <ul>
                      {deployment.unenforcedGuards.map((guard) => (
                        <li key={guard}>{guard}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {!deployment.deployable ? (
                  <div className={styles.reasons} role="note">
                    <strong>This design cannot Zap now on Robinhood Chain today.</strong>
                    <ul>
                      {deployment.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {!automation.deployable ? (
                  <div className={styles.reasons} role="note">
                    <strong>This design cannot be automated on Robinhood Chain today.</strong>
                    <ul>
                      {automation.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}

            <p className={styles.handoffNote}>
              This canvas never connects, approves, funds, signs, or submits.
            </p>
            <details className={styles.disclosure}>
              <summary>How designs become live Zaps</summary>
              <p>
                Deployable one-shot routes hand their exact amount and slippage to Zap now. A Recurring deposit or
                Price trigger on the pinned aeWETH ↔ 0xZAPS route hands cadence or threshold to Automate. The wallet
                still confirms the Zap&rsquo;s creation and its fixed creation fee.
              </p>
              <p>
                The canvas compiles and simulates. It cannot sign, fund, or submit a transaction — that happens in{" "}
                <strong>Zap now</strong>, against whichever deployed routes your design reduces to: swaps, stitched
                multi-pool routes, and aeWETH/USDG liquidity provide/withdraw.
              </p>
            </details>
          </section>

          {/* ---- zap settings ----
              The two numbers every zap needs, surfaced without opening a node.
              These inputs edit the CHAIN — the source block's amount and the
              slippage guard's cap — never a parallel copy, so the compiler,
              the deploy reduction, and the nodes all stay in agreement, and
              every change lands on the undo stack like any other edit. */}
          <section className={styles.card} aria-label="Zap settings">
            <div className={styles.cardHead}>
              <h2>Zap settings</h2>
              <strong className={styles.pillEnd}>
                {settingsAmount === null
                  ? "no source"
                  : settingsAmount.kind === "amount"
                    ? settingsAmount.asset
                    : settingsAmount.name}
              </strong>
            </div>
            <div className={styles.settings}>
              {settingsAmount === null ? (
                <p className={styles.nodeDetail}>Add a source block and its amount appears here.</p>
              ) : settingsAmount.kind === "unparameterised" ? (
                <p className={styles.nodeDetail}>
                  {settingsAmount.name} draws whatever has accrued — it has no amount to set.
                </p>
              ) : (
                <label className={styles.field} htmlFor="zap-settings-amount">
                  <span className={styles.fieldLabel}>
                    {settingsAmount.label} ({settingsAmount.asset})
                  </span>
                  <input
                    id="zap-settings-amount"
                    className={styles.textInput}
                    type="text"
                    inputMode="decimal"
                    spellCheck={false}
                    value={settingsAmount.value}
                    onChange={(event) => setParam(settingsAmount.uid, "amount", event.target.value)}
                  />
                </label>
              )}
              {settingsSlippage ? (
                <label className={styles.field} htmlFor="zap-settings-slippage">
                  <span className={styles.fieldLabel}>
                    Slippage cap
                    <em>{settingsSlippage.bps} bps</em>
                  </span>
                  <input
                    id="zap-settings-slippage"
                    className={styles.range}
                    type="range"
                    min={settingsSlippage.min}
                    max={settingsSlippage.max}
                    step={settingsSlippage.step}
                    value={settingsSlippage.bps}
                    aria-valuetext={`${settingsSlippage.bps} basis points (${(settingsSlippage.bps / 100).toFixed(2)}%)`}
                    onChange={(event) => setParam(settingsSlippage.uid, "bps", Number(event.target.value))}
                  />
                </label>
              ) : (
                <button
                  type="button"
                  className={`${styles.toolBtn} ${styles.toolBtnLg}`}
                  onClick={() => {
                    const guard = getBlock("guard-slippage");
                    if (guard) {
                      addBlock(guard);
                      trackEvent("builder_settings_slippage_added", {});
                    }
                  }}
                >
                  Add a slippage cap
                </button>
              )}
            </div>
            <p className={styles.fieldNote}>
              Not settings: the recipient is always the owner wallet, the relayer fee cap is 0, and the chain is
              Robinhood (4663) — all frozen into the signed policy, on purpose.
            </p>
          </section>

          {/* Live money preview: route output and the separate creation-fee
              conversion stay in one card so "minimum received" cannot read as
              "after a hidden fee". */}
          <section className={styles.card} aria-label="Live route and creation-fee quote">
            <div className={styles.cardHead}>
              <h2>Live quote</h2>
              <strong className={styles.pillEnd}>
                {quoteRouteTarget
                  ? `${quoteRouteTarget.tokenIn.symbol} → ${quoteRouteTarget.tokenOut.symbol}`
                  : "Add a live route"}
              </strong>
              {builderQuote.status === "error" ? (
                <button
                  type="button"
                  className={`${styles.toolBtn} ${styles.toolBtnMd}`}
                  onClick={() => setQuoteRefresh((value) => value + 1)}
                >
                  Retry
                </button>
              ) : null}
            </div>
            {builderQuote.status === "loading" ? (
              <p className={styles.quoteStatus}>Reading the pinned route and fee conversion…</p>
            ) : builderQuote.status === "error" ? (
              <p className={styles.quoteError}>{builderQuote.message}</p>
            ) : builderQuote.status === "ready" && quoteEconomics && quoteRouteTarget && builderQuote.routeId === quoteRouteTarget.id ? (
              <div className={styles.quoteGrid}>
                <div className={styles.quoteCell}>
                  <span>Gross route quote</span>
                  <strong>
                    {formatBuilderToken(builderQuote.amountOut, quoteRouteTarget.tokenOut.decimals)}{" "}
                    {quoteRouteTarget.tokenOut.symbol}
                  </strong>
                </div>
                <div className={styles.quoteCell}>
                  <span>Estimated recipient</span>
                  <strong>
                    {formatBuilderToken(quoteEconomics.recipientOut, quoteRouteTarget.tokenOut.decimals)}{" "}
                    {quoteRouteTarget.tokenOut.symbol}
                  </strong>
                </div>
                <div className={styles.quoteCell}>
                  <span>{automation.deployable ? "Indicative net floor" : "Signed minimum"}</span>
                  <strong>
                    {formatBuilderToken(quoteEconomics.minimumOut, quoteRouteTarget.tokenOut.decimals)}{" "}
                    {quoteRouteTarget.tokenOut.symbol}
                  </strong>
                </div>
                {quoteEconomics.automationFee > 0n ? (
                  <div className={styles.quoteCell}>
                    <span>Automation fee</span>
                    <strong>
                      {formatBuilderToken(quoteEconomics.automationFee, quoteRouteTarget.tokenOut.decimals)}{" "}
                      {quoteRouteTarget.tokenOut.symbol} · 1.00%
                    </strong>
                  </div>
                ) : null}
                <div className={styles.quoteCell}>
                  <span>Creation fee</span>
                  <strong>{formatBuilderToken(OPENZAP_CREATION_FEE, 18)} ETH</strong>
                </div>
                <div className={styles.quoteCell}>
                  <span>Fee conversion floor</span>
                  <strong>
                    {formatBuilderToken(
                      (builderQuote.feeZapsOut * BigInt(10_000 - OPENZAP_CREATION_FEE_SLIPPAGE_BPS)) / 10_000n,
                      18,
                    )}{" "}
                    0xZAPS
                  </strong>
                </div>
              </div>
            ) : (
              <p className={styles.quoteStatus}>Choose a deployable or automatable blueprint to price it here.</p>
            )}
            <p className={styles.quoteNote}>
              {automation.deployable
                ? "Automated Zaps retain the live 1% output fee: 80% rewards the executor and 20% enters the existing 0xZAPS conversion pot. "
                : ""}
              The separate creation fee is paid only if the Zap&rsquo;s creation succeeds and atomically converted
              through the pinned aeWETH → 0xZAPS adapter.
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Guard coverage</h2>
              <strong className={`${styles.pillEnd} ${styles.mono}`}>{compiled.guardScore}%</strong>
            </div>
            <div className={styles.meterTrack}>
              <span
                style={{ width: `${compiled.guardScore}%` }}
                data-level={compiled.guardScore === 100 ? "full" : compiled.guardScore >= 50 ? "part" : "low"}
              />
            </div>
            {/* Each gap names the risk that opened it and adds the piece that
                closes it. The percentage alone was a grade, not a next step. */}
            {compiled.missingGuards.length > 0 ? (
              <ul className={styles.gaps}>
                {compiled.missingGuards.map((demand) => {
                  const guard = getBlock(demand.guardId);
                  if (!guard) return null;
                  return (
                    <li key={demand.guardId}>
                      <span>
                        No <strong>{guard.name}</strong> — {demand.risk}.
                      </span>
                      <button
                        type="button"
                        className={`${styles.toolBtn} ${styles.toolBtnSm}`}
                        onClick={() => {
                          addBlock(guard);
                          trackEvent("builder_guard_gap_filled", { guard: guard.id });
                        }}
                        aria-label={`Add ${guard.name} to close this gap`}
                      >
                        Add
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          {/* Every issue the compiler raised, not the first one. The "Connector
              fit" check below can only ever quote a single message, so a chain
              with three broken joints used to report one and leave the other
              two to be found by eye. Each one that names a block is a button
              that goes there. */}
          {compiled.issues.length > 0 ? (
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>Problems</h2>
                <span className={`${styles.pill} ${styles.pillEnd}`} data-tone="danger">
                  {compiled.issues.length}
                </span>
              </div>
              <ul className={styles.issues} aria-label={`${compiled.issues.length} problems in this design`}>
                {compiled.issues.map((issue, index) => (
                  <li key={`${issue.code ?? "chain"}-${issue.uid ?? index}`} data-level={issue.level}>
                    {issue.uid ? (
                      <button type="button" onClick={() => revealNode(issue.uid as string)}>
                        <span>{issue.message}</span>
                        <em aria-hidden>Show</em>
                      </button>
                    ) : (
                      <span>{issue.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Checks</h2>
            </div>
            <ul className={styles.checks}>
              {compiled.checks.map((check) => (
                <li key={check.label} data-status={check.status}>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.card}>
            <div className={styles.hashRow}>
              <span>Design fingerprint</span>
              <CopyButton
                value={compiled.hash}
                label={`${compiled.hash.slice(0, 10)}…${compiled.hash.slice(-6)}`}
                title="Copy this design's fingerprint"
              />
            </div>
            <p className={styles.hashNote}>
              A local checksum (FNV-1a) that tells two designs apart. It is <strong>not</strong> the onchain policy
              hash: a deployed Zap commits to a keccak256 hash of its ABI-encoded policy, so this value will not
              match anything on a block explorer.
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.actions}>
              <CopyButton
                className={styles.actionBtn}
                value={shareUrl}
                label="Copy share link"
                title="Copy a link that reopens this exact design"
              />
              <CopyButton
                className={styles.actionBtn}
                value={exportPayload}
                label="Copy design JSON"
                title="Copy the compiled chain"
              />

              {/* Durable, named saves — the draft answers "put my canvas back";
                  the library answers "keep this one, I'm starting another". */}
              <button
                type="button"
                className={styles.actionBtn}
                aria-expanded={naming}
                disabled={chain.length === 0}
                onClick={() => setNaming((open) => !open)}
              >
                {naming ? "Cancel save" : "Save to library"}
              </button>
              {naming ? (
                <div className={styles.import}>
                  <label htmlFor="library-name">
                    Name this design. Saving under an existing name updates it.
                  </label>
                  <input
                    id="library-name"
                    type="text"
                    value={libraryName}
                    autoFocus
                    maxLength={MAX_DESIGN_NAME}
                    spellCheck={false}
                    placeholder="e.g. Weekly aeWETH → 0xZAPS"
                    onChange={(event) => setLibraryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setNaming(false);
                      if (event.key === "Enter") saveToLibrary();
                    }}
                  />
                  <button
                    type="button"
                    className={`${styles.toolBtn} ${styles.toolBtnLg}`}
                    onClick={saveToLibrary}
                    disabled={!libraryName.trim()}
                  >
                    Save design
                  </button>
                </div>
              ) : null}

              {/* The other half of those two buttons. A design copied out as JSON
                  had no way back in except by hand. */}
              <button
                type="button"
                className={styles.actionBtn}
                aria-expanded={importing}
                onClick={() => setImporting((open) => !open)}
              >
                {importing ? "Cancel import" : "Paste a design"}
              </button>
              {importing ? (
                <div className={styles.import}>
                  <label htmlFor="import-design">Paste a share link or a copied design JSON.</label>
                  <textarea
                    id="import-design"
                    value={importText}
                    rows={3}
                    spellCheck={false}
                    placeholder="https://www.0xzaps.com/zap?d=… or { &quot;chain&quot;: [ … ] }"
                    onChange={(event) => setImportText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setImporting(false);
                      // Enter alone would fight the textarea; the modifier is the
                      // usual "send this" gesture and the button is right there.
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) importDesign();
                    }}
                  />
                  <button
                    type="button"
                    className={`${styles.toolBtn} ${styles.toolBtnLg}`}
                    onClick={importDesign}
                    disabled={!importText.trim()}
                  >
                    Load design
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </aside>
      </div>

      {drag?.active && dragBlock ? (
        <div
          className={styles.ghost}
          style={{
            width: drag.width,
            transform: `translate3d(${drag.x - drag.dx}px, ${drag.y - drag.dy}px, 0)`,
          }}
          data-valid={dropValid && dropIndex !== null}
          aria-hidden
        >
          <BlockGlyph name={dragBlock.glyph} />
          <strong>{dragBlock.name}</strong>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether a keystroke landed somewhere the browser's own undo already works.
 *
 * A range input is deliberately not one: dragging a slider leaves nothing for
 * the native stack to restore, so ⌘Z there has to mean the canvas's undo.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && target.type !== "range";
}

/**
 * What a node calls itself on the canvas.
 *
 * The ends of a chain are the two things a reader looks for first, so they are
 * named by their role rather than by their catalogue group; everything in
 * between falls back to the group the palette filed it under.
 */
function eyebrowFor(block: LegoBlock): string {
  if (block.kind === "source") return "TOKEN IN";
  if (block.kind === "sink") return "TOKEN OUT";
  if (block.kind === "guard") return "GUARD";
  return CATEGORY_LABEL[block.category].toUpperCase();
}

/** A block's params at their catalogue defaults, for palette-time protocol badges. */
function defaultParams(block: LegoBlock): Record<string, ParamValue> {
  return Object.fromEntries(block.params.map((param) => [param.key, param.value]));
}

/** One-line description of a placed block's current settings. */
function summarise(block: LegoBlock, node: ChainNode): string {
  const parts = block.params.map((param) => {
    const value = node.params[param.key] ?? param.value;
    return `${value}${paramSuffix(param)}`;
  });
  return parts.length ? parts.join(" · ") : block.blurb;
}

/** Compact bigint formatting for the builder's indicative quote card. */
function formatBuilderToken(value: bigint, decimals: number): string {
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const visible = fraction.slice(0, 6).replace(/0+$/, "");
  return visible ? `${grouped}.${visible}` : grouped;
}
