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
  getBlock,
  makeNode,
  type BlockCategory,
  type ChainNode,
  type LegoBlock,
  type ParamValue,
  type ZapRecipe,
} from "@/lib/blocks";
import { BlockGlyph } from "./BlockGlyph";
import styles from "./build.module.css";

const STORAGE_KEY = "openzaps:zap-builder:v1";
/** Pointer travel before a press becomes a drag, so taps still register. */
const DRAG_THRESHOLD = 6;

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
 * The saved draft, read from storage exactly once per page load.
 *
 * `useSyncExternalStore` is what makes this hydration-safe: the server snapshot
 * is always `null`, so the server and the first client render agree, and React
 * swaps in the real draft immediately after hydrating. Re-reading the key later
 * would be wrong anyway — the builder writes to it constantly, so a live read
 * would just echo the component's own state back at it.
 */
let cachedDraft: Draft | null | undefined;

function readDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Draft>;
    // Drop anything referencing a block this build no longer ships rather than
    // rendering a chain with holes in it.
    const chain = (saved.chain ?? []).filter((node) => node && getBlock(node.blockId));
    if (!chain.length) return null;
    // Restored placements keep their ids, so the counter has to resume past
    // them or the next drop would collide with a card already on the canvas.
    for (const node of chain) {
      const serial = node.uid.match(/^p(\d+)$/);
      if (serial) placementCounter = Math.max(placementCounter, Number(serial[1]));
    }
    return { chain, recipeId: saved.recipeId ?? "" };
  } catch {
    // A corrupt draft is not worth failing the page over.
    return null;
  }
}

function draftSnapshot(): Draft | null {
  if (cachedDraft === undefined) cachedDraft = readDraft();
  return cachedDraft;
}

function serverSnapshot(): null {
  return null;
}

/** Nothing else writes this key, so there is no external change to subscribe to. */
function subscribeToDraft(): () => void {
  return () => {};
}

export function ZapBuilder(): React.JSX.Element {
  // The chain is whatever the user has edited this session, falling back to the
  // saved draft and finally to the opening blueprint.
  const stored = useSyncExternalStore(subscribeToDraft, draftSnapshot, serverSnapshot);
  const [edited, setEdited] = useState<Draft | null>(null);
  const draft = edited ?? stored ?? DEFAULT_DRAFT;
  const chain = draft.chain;
  const recipeId = draft.recipeId;
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [category, setCategory] = useState<BlockCategory | "all">("all");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropValid, setDropValid] = useState(false);
  const [runIndex, setRunIndex] = useState(-1);
  const [hint, setHint] = useState("");

  const cardRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const runTimer = useRef<number | undefined>(undefined);

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
   */
  const commit = useCallback(
    (next: ChainNode[], recipe = ""): void => {
      stopRun();
      setEdited({ chain: next, recipeId: recipe });
    },
    [stopRun],
  );

  /** The lowest legal seat for a block, or null when it does not fit at all. */
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
      );
    },
    [chain, commit],
  );

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

  const visibleBlocks = useMemo(
    () => (category === "all" ? BLOCKS : BLOCKS.filter((block) => block.category === category)),
    [category],
  );

  const exportPayload = useMemo(
    () =>
      JSON.stringify(
        {
          version: 1,
          policyHash: compiled.hash,
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

  const dragBlock = drag ? getBlock(drag.blockId) : undefined;

  return (
    <div className={styles.builder} data-dragging={drag?.active ? "true" : "false"}>
      <section className={styles.recipes} aria-label="Zap blueprints">
        <div className={styles.recipeHead}>
          <h2>Start from a blueprint</h2>
          <p>Six kinds of zap, each a different DeFi activity. Load one, then rebuild it piece by piece.</p>
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
              <em>{recipe.blocks.length} blocks</em>
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
              <p>{chain.length} block{chain.length === 1 ? "" : "s"} · {compiled.gas.toLocaleString("en-US")} gas</p>
            </div>
            <div className={styles.canvasActions}>
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
              >
                Clear
              </button>
            </div>
          </header>

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
                                        {param.suffix ? ` ${param.suffix}` : ""}
                                      </em>
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
              <span>
                {compiled.gas.toLocaleString("en-US")} gas · {chain.length} block{chain.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <div className={styles.meter}>
            <div className={styles.meterHead}>
              <span>Guard coverage</span>
              <strong>{compiled.guardScore}%</strong>
            </div>
            <div className={styles.meterTrack}>
              <span style={{ width: `${compiled.guardScore}%` }} data-level={compiled.guardScore === 100 ? "full" : compiled.guardScore >= 50 ? "part" : "low"} />
            </div>
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
            <span>Policy hash</span>
            <CopyButton value={compiled.hash} label={`${compiled.hash.slice(0, 10)}…${compiled.hash.slice(-6)}`} />
          </div>

          <div className={styles.readoutActions}>
            <CopyButton className={styles.exportBtn} value={exportPayload} label="Copy policy JSON" title="Copy the compiled chain" />
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

/** One-line description of a placed block's current settings. */
function summarise(block: LegoBlock, node: ChainNode): string {
  const parts = block.params.map((param) => {
    const value = node.params[param.key] ?? param.value;
    const suffix = param.type === "number" && param.suffix ? param.suffix : "";
    return `${value}${suffix}`;
  });
  return parts.length ? parts.join(" · ") : block.blurb;
}
