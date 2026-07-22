"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CopyButton } from "@/components/CopyButton";
import { trackEvent } from "@/lib/analytics";
import {
  BLOCKS,
  CATEGORY_LABEL,
  RECIPES,
  SHAPE_COLOR,
  SHAPE_LABEL,
  canInsert,
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
  type LegoBlock,
  type ParamValue,
  type ZapRecipe,
} from "@/lib/blocks";
import { reduceChainToLiveRoute } from "@/lib/deployable";
import { edgeScrollDelta } from "@/lib/drag";
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

const CATEGORIES: Array<BlockCategory | "all"> = [
  "all",
  "source",
  "swap",
  "lend",
  "liquidity",
  "yield",
  "bridge",
  "guard",
  "sink",
];

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
 * Derived rather than declared on the recipe, so the badge cannot drift from
 * the verdict: the day a catalog edit knocks a blueprint off the live route,
 * its badge goes with it in the same render. `RECIPES` is static, so this is
 * computed once for the module rather than once per keystroke.
 */
const DEPLOYABLE_RECIPES: ReadonlySet<string> = new Set(
  RECIPES.filter((recipe) => reduceChainToLiveRoute(nodesFromRecipe(recipe)).deployable).map((recipe) => recipe.id),
);

/**
 * The chain this page opens with, resolved exactly once per page load.
 *
 * `useSyncExternalStore` is what makes this hydration-safe: the server snapshot
 * is always `null`, so the server and the first client render agree, and React
 * swaps in the real chain immediately after hydrating. Re-reading later would be
 * wrong anyway — the builder writes to storage constantly, so a live read would
 * just echo the component's own state back at it. Seeding a shared design goes
 * through this same snapshot rather than an effect, because setting state from
 * an effect body is a hard lint error here (and would flash the wrong chain).
 */
let cachedDraft: Draft | null | undefined;

function readInitialDraft(): Draft | null {
  return readSharedDraft() ?? readDraft();
}

/**
 * A design carried in `?d=`, which wins over the saved draft.
 *
 * Following a share link is a request to see *that* design; the local draft is
 * untouched in storage and comes back at a bare /build. The query is read from
 * `window.location.search` rather than `useSearchParams()`, which would push
 * this statically rendered page into a client-side render bailout.
 */
function readSharedDraft(): Draft | null {
  try {
    const token = new URLSearchParams(window.location.search).get(SHARE_PARAM);
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

function draftSnapshot(): Draft | null {
  if (cachedDraft === undefined) cachedDraft = readInitialDraft();
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
 * Neither the draft key nor the location changes underneath this page, so there
 * is nothing to subscribe to — the store exists purely for its hydration-safe
 * server snapshot.
 */
function subscribeNever(): () => void {
  return () => {};
}

export function ZapBuilder(): React.JSX.Element {
  // The chain is whatever the user has edited this session, falling back to the
  // saved draft and finally to the opening blueprint.
  const stored = useSyncExternalStore(subscribeNever, draftSnapshot, serverSnapshot);
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
  const [category, setCategory] = useState<BlockCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropValid, setDropValid] = useState(false);
  const [runIndex, setRunIndex] = useState(-1);
  const [hint, setHint] = useState("");
  // Whole drafts, oldest first. Storing the design rather than a diff is what
  // keeps undo trivially correct: every entry is a state the canvas already
  // rendered once, so restoring one cannot produce a chain that never existed.
  const [past, setPast] = useState<readonly Draft[]>([]);
  const [future, setFuture] = useState<readonly Draft[]>([]);

  const cardRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
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
  }, [draft, past, stopRun]);

  const redo = useCallback((): void => {
    if (future.length === 0) return;
    stopRun();
    setFuture((entries) => entries.slice(1));
    setPast((entries) => [...entries, draft].slice(-HISTORY_LIMIT));
    coalesceRef.current = undefined;
    setEdited(future[0]);
  }, [draft, future, stopRun]);

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

  const insertBlock = useCallback(
    (blockId: string, index: number): void => {
      const uid = nextUid();
      const next = [...chain];
      next.splice(index, 0, makeNode(blockId, uid));
      commit(next);
      setOpenUid(uid);
      trackEvent("builder_block_added", { block: blockId });
    },
    [chain, commit],
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
      commit(chain.filter((node) => node.uid !== uid));
      setOpenUid((current) => (current === uid ? null : current));
    },
    [chain, commit],
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
    },
    [canMove, chain, commit],
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
      trackEvent("builder_block_duplicated", { block: block.id });
    },
    [chain, commit, flash],
  );

  /** Scroll a block into view, open it, and flag it briefly. */
  const revealNode = useCallback((uid: string): void => {
    setOpenUid(uid);
    setFlaggedUid(uid);
    cardRefs.current.get(uid)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    window.clearTimeout(flagTimer.current);
    flagTimer.current = window.setTimeout(() => setFlaggedUid(null), FLAG_MS);
  }, []);

  const loadRecipe = useCallback(
    (recipe: ZapRecipe): void => {
      commit(nodesFromRecipe(recipe), recipe.id);
      setOpenUid(null);
      trackEvent("builder_recipe_loaded", { recipe: recipe.id });
    },
    [commit],
  );

  // ---- drag and drop -------------------------------------------------------
  // Pointer events rather than HTML5 drag-and-drop: the native API has no touch
  // implementation at all, so a phone would be left with no way to compose a
  // chain. One code path now covers mouse, pen, and finger.

  const resolveDrop = useCallback(
    (state: DragState, y: number): { index: number | null; valid: boolean } => {
      const canvas = canvasRef.current;
      if (!canvas) return { index: null, valid: false };
      const bounds = canvas.getBoundingClientRect();
      // A generous margin: on a phone the chain fills the screen and the finger
      // regularly strays past the panel edge mid-drag.
      if (y < bounds.top - 120 || y > bounds.bottom + 120) return { index: null, valid: false };

      const working = state.from === "chain" ? chain.filter((node) => node.uid !== state.uid) : chain;

      let index = working.length;
      for (let i = 0; i < working.length; i++) {
        const el = cardRefs.current.get(working[i].uid);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
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
   * Scroll the page while a block is held against a viewport edge.
   *
   * Driven by animation frames rather than by pointer movement, because the
   * gesture that needs this most is a finger parked at the bottom of the screen
   * — which emits no `pointermove` at all. Each frame that actually scrolls
   * re-resolves the drop: the pointer has not moved, but every card under it
   * has. The pointer position is read from the ref rather than from `drag`, so
   * the loop is set up once per gesture instead of once per pixel travelled.
   */
  useEffect(() => {
    if (!dragActive) return;
    let frame = window.requestAnimationFrame(function step(): void {
      const state = dragRef.current;
      if (state?.active) {
        const delta = edgeScrollDelta(state.y, window.innerHeight);
        if (delta !== 0) {
          const before = window.scrollY;
          window.scrollBy(0, delta);
          // At either end of the document `scrollBy` is a no-op, and
          // re-resolving a drop that cannot have moved would churn state
          // every frame for as long as the block is held there.
          if (window.scrollY !== before) {
            const drop = resolveDrop(state, state.y);
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
      const drop = resolveDrop(next, event.clientY);
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

      const drop = resolveDrop(state, event.clientY);
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
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    trackEvent("builder_preview_run", { blocks: chain.length });
  }, [chain.length, compiled.status]);

  /**
   * The palette, narrowed by tab and by search.
   *
   * The search reads the blurb and the category label as well as the name,
   * because the word someone reaches for is rarely the block's title: "dca"
   * finds the recurring deposit through its blurb, "borrow" finds the whole
   * lending group through its category.
   */
  const visibleBlocks = useMemo(() => {
    const byCategory = category === "all" ? BLOCKS : BLOCKS.filter((block) => block.category === category);
    const needle = query.trim().toLowerCase();
    if (!needle) return byCategory;
    return byCategory.filter((block) =>
      `${block.name} ${block.blurb} ${CATEGORY_LABEL[block.category]}`.toLowerCase().includes(needle),
    );
  }, [category, query]);

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

  const shareUrl = useMemo(() => `${origin}/build?${SHARE_PARAM}=${encodeChain(chain)}`, [chain, origin]);

  /** What, if anything, of this design the live v1.1 contracts can carry. */
  const deployment = useMemo(() => reduceChainToLiveRoute(chain), [chain]);
  const deployHref = deployment.deployable
    ? `/app?src=build&dir=${deployment.direction}&amount=${encodeURIComponent(deployment.amountIn)}&bps=${deployment.slippageBps}`
    : null;

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
      flash("That is not a design. Paste a /build share link or the JSON from “Copy design JSON”.");
      return;
    }
    advancePlacementCounter(nodes);
    commit(nodes);
    setOpenUid(null);
    setImportText("");
    setImporting(false);
    flash(`Loaded ${nodes.length} block${nodes.length === 1 ? "" : "s"}. ⌘Z puts your previous chain back.`);
    trackEvent("builder_design_imported", { blocks: nodes.length });
  }, [commit, flash, importText]);

  const saveDesign = useCallback((): void => {
    // The draft already persists on every edit; this is the explicit route for
    // a chain that arrived from a share link or a blueprint and has not been
    // touched, which would otherwise never have been written.
    setEdited({ chain, recipeId });
    setSavedChain(chain);
    trackEvent("builder_design_saved", { blocks: chain.length });
  }, [chain, recipeId]);

  const dragBlock = drag ? getBlock(drag.blockId) : undefined;

  return (
    <div className={styles.builder} data-dragging={drag?.active ? "true" : "false"}>
      <section className={styles.recipes} aria-label="Zap blueprints">
        <div className={styles.recipeHead}>
          <h2>Start from a blueprint</h2>
          {/* No count in the copy: it went stale the first time a blueprint was
              added, and the row is right there to be counted. */}
          <p>
            One kind of zap each. The one marked <em>deployable</em> is the only shape today’s contracts can carry —
            load any of them, then rebuild piece by piece.
          </p>
        </div>
        <div className={styles.recipeRow}>
          {RECIPES.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className={styles.recipe}
              data-active={recipe.id === recipeId}
              style={{ ["--accent" as string]: SHAPE_COLOR[recipe.accent] }}
              onClick={() => loadRecipe(recipe)}
            >
              <strong>{recipe.name}</strong>
              <span>{recipe.tagline}</span>
              <em>
                {recipe.blocks.length} blocks
                {DEPLOYABLE_RECIPES.has(recipe.id) ? <i className={styles.recipeLive}>deployable</i> : null}
              </em>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.workspace}>
        {/* ---- palette ---- */}
        <aside className={styles.palette} aria-label="Block palette">
          <div className={styles.paletteHead}>
            <h2>Blocks</h2>
            <p className={styles.paletteHint}>Drag into the chain, or tap to drop it in the first slot that fits.</p>
          </div>
          <div className={styles.search}>
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
          <div className={styles.tabs} role="tablist" aria-label="Block categories">
            {CATEGORIES.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={category === entry}
                className={styles.tab}
                onClick={() => setCategory(entry)}
              >
                {entry === "all" ? "All" : CATEGORY_LABEL[entry]}
              </button>
            ))}
          </div>
          <div className={styles.paletteList}>
            {visibleBlocks.length === 0 ? (
              <p className={styles.noMatch} role="status">
                No block matches “{query.trim()}”
                {category === "all" ? "." : ` in ${CATEGORY_LABEL[category]}. Try All.`}
              </p>
            ) : null}
            {visibleBlocks.map((block) => {
              const fits = bestIndexFor(block) !== null;
              const accent = SHAPE_COLOR[block.emits ?? block.accepts ?? "token"];
              return (
                <button
                  key={block.id}
                  type="button"
                  className={styles.chip}
                  data-fits={fits}
                  data-kind={block.kind}
                  data-lifted={drag?.from === "palette" && drag.blockId === block.id && drag.active}
                  style={{ ["--accent" as string]: accent }}
                  onPointerDown={(event) => beginDrag(event, { from: "palette", blockId: block.id })}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={cancelDrag}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    addBlock(block);
                  }}
                  aria-label={`${block.name}. ${block.blurb} ${fits ? "Fits the current chain." : "Does not fit the current chain yet."}`}
                >
                  <span className={styles.chipIcon}>
                    <BlockGlyph name={block.glyph} className={styles.glyph} />
                  </span>
                  <span className={styles.chipText}>
                    <strong>{block.name}</strong>
                    <span>{block.blurb}</span>
                  </span>
                  <span className={styles.chipPorts} aria-hidden>
                    {block.accepts ? <i style={{ background: SHAPE_COLOR[block.accepts] }} /> : null}
                    {block.emits ? <i style={{ background: SHAPE_COLOR[block.emits] }} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ---- canvas ---- */}
        <section className={styles.canvasWrap} aria-label="Zap chain">
          <header className={styles.canvasHead}>
            <div>
              <h2>Your zap</h2>
              <p title={GAS_ESTIMATE_NOTE}>
                {chain.length} block{chain.length === 1 ? "" : "s"} · ≈{compiled.gas.toLocaleString("en-US")} gas (estimate)
              </p>
            </div>
            <div className={styles.canvasActions}>
              <button
                type="button"
                className={`${styles.ghostBtn} ${styles.iconBtn}`}
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
                className={`${styles.ghostBtn} ${styles.iconBtn}`}
                onClick={redo}
                disabled={future.length === 0}
                aria-label="Redo"
                aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                title="Redo (⇧⌘Z)"
              >
                ↷
              </button>
              <button type="button" className={styles.ghostBtn} onClick={previewRun} disabled={compiled.status === "block" || !chain.length}>
                Preview run
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  commit([]);
                  setOpenUid(null);
                }}
                disabled={!chain.length}
                title="Clear the canvas — ⌘Z brings it back"
              >
                Clear
              </button>
            </div>
          </header>

          <p className={styles.scopeBanner} role="note">
            <strong>This canvas designs zaps — it does not deploy them.</strong> Every chain here compiles and
            simulates, but the only one the live contracts can carry today is a single-step aeWETH ↔ 0xZAPS swap.
            Anything else is saved as a design, and the panel on the right says which one you have.
          </p>

          <div className={styles.canvas} ref={canvasRef}>
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
              const accent = SHAPE_COLOR[block.emits ?? block.accepts ?? "token"];
              const lifted = drag?.from === "chain" && drag.uid === node.uid && drag.active;

              return (
                <div key={node.uid} className={styles.slotGroup}>
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
                      className={styles.joint}
                      data-status={joint?.status ?? "ok"}
                      data-flowing={runIndex >= index}
                      style={{ ["--accent" as string]: incoming ? SHAPE_COLOR[incoming] : "#ff7a90" }}
                    >
                      <span className={styles.jointLine} />
                      <span className={styles.jointLabel}>
                        {joint?.status === "mismatch" || joint?.status === "orphan"
                          ? "does not fit"
                          : incoming
                            ? SHAPE_LABEL[incoming]
                            : "start"}
                      </span>
                    </div>
                  ) : null}

                  <article
                    ref={(el) => {
                      if (el) cardRefs.current.set(node.uid, el);
                      else cardRefs.current.delete(node.uid);
                    }}
                    className={styles.card}
                    data-kind={block.kind}
                    data-open={open}
                    data-lifted={lifted}
                    data-broken={joint?.status === "mismatch" || joint?.status === "orphan"}
                    data-running={runIndex === index}
                    data-flagged={flaggedUid === node.uid}
                    style={{ ["--accent" as string]: accent }}
                  >
                    <div className={styles.cardMain}>
                      <span
                        className={styles.handle}
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
                        <BlockGlyph name={block.glyph} className={styles.glyph} />
                      </span>

                      <button
                        type="button"
                        className={styles.cardTitle}
                        aria-expanded={open}
                        onClick={() => setOpenUid(open ? null : node.uid)}
                      >
                        <strong>{block.name}</strong>
                        <span>{summarise(block, node)}</span>
                      </button>

                      <span className={styles.cardTools}>
                        <span className={styles.maturity} data-level={block.maturity}>
                          {block.maturity}
                        </span>
                        <button
                          type="button"
                          onClick={() => moveNode(node.uid, -1)}
                          disabled={!canMove(node.uid, -1)}
                          aria-label={`Move ${block.name} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveNode(node.uid, 1)}
                          disabled={!canMove(node.uid, 1)}
                          aria-label={`Move ${block.name} down`}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateNode(node.uid)}
                          disabled={!canInsert(chain, block, index + 1)}
                          aria-label={`Duplicate ${block.name}`}
                          title={`Duplicate ${block.name} with these settings`}
                        >
                          ⧉
                        </button>
                        <button type="button" onClick={() => removeNode(node.uid)} aria-label={`Remove ${block.name}`}>
                          ✕
                        </button>
                      </span>
                    </div>

                    {open ? (
                      <div className={styles.cardBody}>
                        <p>{block.detail}</p>
                        {block.params.length ? (
                          <div className={styles.params}>
                            {block.params.map((param) => {
                              const id = `${node.uid}-${param.key}`;
                              const value = node.params[param.key] ?? param.value;
                              return (
                                <label key={param.key} className={styles.param} htmlFor={id}>
                                  <span className={styles.paramLabel}>
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
                </div>
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

          {hint ? (
            <p className={styles.hint} role="status">
              {hint}
            </p>
          ) : null}
        </section>

        {/* ---- readout ---- */}
        <aside className={styles.readout} aria-label="Policy readout">
          <div className={styles.verdict} data-status={compiled.status}>
            <span className={styles.verdictDot} />
            <div>
              <strong>
                {compiled.status === "pass" ? "Ready to simulate" : compiled.status === "warn" ? "Needs a review" : "Will not compile"}
              </strong>
              <span title={GAS_ESTIMATE_NOTE}>
                ≈{compiled.gas.toLocaleString("en-US")} gas (estimate) · {chain.length} block
                {chain.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* Every issue the compiler raised, not the first one. The "Connector
              fit" check below can only ever quote a single message, so a chain
              with three broken joints used to report one and leave the other
              two to be found by eye. Each one that names a block is a button
              that goes there. */}
          {compiled.issues.length > 0 ? (
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
          ) : null}

          <div className={styles.meter}>
            <div className={styles.meterHead}>
              <span>Guard coverage</span>
              <strong>{compiled.guardScore}%</strong>
            </div>
            <div className={styles.meterTrack}>
              <span style={{ width: `${compiled.guardScore}%` }} data-level={compiled.guardScore === 100 ? "full" : compiled.guardScore >= 50 ? "part" : "low"} />
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
          </div>

          <ul className={styles.checks}>
            {compiled.checks.map((check) => (
              <li key={check.label} data-status={check.status}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>

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
            hash: a deployed capsule commits to a keccak256 hash of its ABI-encoded policy, so this value will not
            match anything on a block explorer.
          </p>

          {deployment.deployable && deployHref ? (
            <div className={styles.deploy} data-deployable="true">
              <Link
                className={styles.deployBtn}
                href={deployHref}
                onClick={() => trackEvent("builder_deploy_handoff", { direction: deployment.direction })}
              >
                Deploy on Robinhood Chain →
              </Link>
              <p className={styles.deployNote}>
                This design reduces to the live route. The app page opens with{" "}
                {deployment.direction === "buy" ? "aeWETH → 0xZAPS" : "0xZAPS → aeWETH"}, {deployment.amountIn}{" "}
                {deployment.direction === "buy" ? "aeWETH" : "0xZAPS"}, and a{" "}
                {(deployment.slippageBps / 100).toFixed(2)}% signed slippage cap filled in. You still create, fund,
                and sign there — nothing is submitted from here.
              </p>
              {deployment.unenforcedGuards.length > 0 ? (
                // Rendered in full, in the CTA's own line of sight. Summarising
                // or counting these would let someone deploy believing a guard
                // they drew is protecting funds that nothing is protecting.
                <div className={styles.unenforced} role="note">
                  <strong>
                    {deployment.unenforcedGuards.length} guard
                    {deployment.unenforcedGuards.length === 1 ? " in this design is" : "s in this design are"} not
                    enforced onchain.
                  </strong>
                  <p>
                    The v1.1 policy binds owner, recipient, adapter, spender, input token, and exact amount — and
                    nothing else. Deploying keeps those bounds and drops the rest:
                  </p>
                  <ul>
                    {deployment.unenforcedGuards.map((guard) => (
                      <li key={guard}>{guard}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className={styles.deploy} data-deployable="false">
              <button type="button" className={styles.saveBtn} onClick={saveDesign}>
                {savedChain === chain ? "Saved as design ✓" : "Save as design"}
              </button>
              {!deployment.deployable ? (
                <div className={styles.reasons} role="note">
                  <strong>This design cannot be deployed on Robinhood Chain today.</strong>
                  <ul>
                    {deployment.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          <div className={styles.readoutActions}>
            <CopyButton
              className={styles.exportBtn}
              value={shareUrl}
              label="Copy share link"
              title="Copy a link that reopens this exact design"
            />
            <CopyButton className={styles.exportBtn} value={exportPayload} label="Copy design JSON" title="Copy the compiled chain" />

            {/* The other half of those two buttons. A design copied out as JSON
                had no way back in except by hand. */}
            <button
              type="button"
              className={styles.importToggle}
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
                  placeholder="https://www.0xzaps.com/build?d=… or { &quot;chain&quot;: [ … ] }"
                  onChange={(event) => setImportText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setImporting(false);
                    // Enter alone would fight the textarea; the modifier is the
                    // usual "send this" gesture and the button is right there.
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) importDesign();
                  }}
                />
                <button type="button" onClick={importDesign} disabled={!importText.trim()}>
                  Load design
                </button>
              </div>
            ) : null}

            <Link className={styles.openApp} href="/app">
              Open the live app →
            </Link>
          </div>

          <p className={styles.disclaimer}>
            The builder compiles and simulates only. Nothing here signs, funds, or submits a transaction — the live route
            on the app page remains the bounded aeWETH ↔ 0xZAPS capsule.
          </p>
        </aside>
      </div>

      {drag?.active && dragBlock ? (
        <div
          className={styles.ghost}
          style={{
            width: drag.width,
            transform: `translate3d(${drag.x - drag.dx}px, ${drag.y - drag.dy}px, 0)`,
            ["--accent" as string]: SHAPE_COLOR[dragBlock.emits ?? dragBlock.accepts ?? "token"],
          }}
          data-valid={dropValid && dropIndex !== null}
          aria-hidden
        >
          <BlockGlyph name={dragBlock.glyph} className={styles.glyph} />
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

/** One-line description of a placed block's current settings. */
function summarise(block: LegoBlock, node: ChainNode): string {
  const parts = block.params.map((param) => {
    const value = node.params[param.key] ?? param.value;
    return `${value}${paramSuffix(param)}`;
  });
  return parts.length ? parts.join(" · ") : block.blurb;
}
