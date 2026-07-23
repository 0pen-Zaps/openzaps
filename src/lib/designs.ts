import { decodeChain, encodeChain, getBlock, type ChainNode, type FlowShape } from "@/lib/blocks";

/**
 * The design library: named, durable saves of builder chains.
 *
 * The single autosaved draft answers "put my canvas back"; the library
 * answers "keep this one, I'm starting another". Each entry stores the chain
 * as the same URL-safe token share links use — one codec, one migration
 * story, and any library entry is a share link waiting to happen.
 *
 * The pure functions here operate on plain arrays so they can be tested
 * without a DOM; the two storage functions at the bottom are the only code
 * that touches localStorage, and both fail soft — a corrupt library reads as
 * empty rather than taking the builder down with it.
 */

export type SavedDesign = {
  /** Stable identity across renames. */
  id: string;
  name: string;
  /** `encodeChain` token — decode with `decodeChain`, share as `/zap?d=`. */
  token: string;
  /** Denormalised for display; the token is the source of truth. */
  blocks: number;
  /** Output shape at save time, for the accent swatch. */
  accent: FlowShape;
  updatedAt: number;
};

export type SaveResult =
  | { ok: true; list: SavedDesign[]; saved: SavedDesign; replaced: boolean }
  | { ok: false; reason: string };

const STORAGE_KEY = "openzaps:design-library:v1";

/**
 * A hard cap instead of silent eviction: the library refuses the 25th save
 * rather than quietly deleting the oldest one. Deleting a user's saved work
 * to make room for more of it is the one behaviour a library must not have.
 */
export const MAX_SAVED_DESIGNS = 24;
export const MAX_DESIGN_NAME = 48;

export function normalizeDesignName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_DESIGN_NAME);
}

/**
 * What a chain ends up holding: the last shape any block emits. Sinks emit
 * null (they settle, they don't hand anything on), so `compileChain`'s
 * outputShape is null for every finished design — the shape worth showing is
 * the one that reached the sink.
 */
export function settledShape(chain: readonly ChainNode[]): FlowShape | null {
  let shape: FlowShape | null = null;
  for (const node of chain) {
    const emits = getBlock(node.blockId)?.emits;
    if (emits) shape = emits;
  }
  return shape;
}

function sortNewestFirst(list: readonly SavedDesign[]): SavedDesign[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * Save a chain under a name. Saving under an existing name (case-insensitive)
 * replaces that entry and keeps its identity — "overwrite my WIP" — while a
 * new name creates a new entry, refused only when the library is full.
 */
export function upsertDesign(
  list: readonly SavedDesign[],
  input: { name: string; chain: readonly ChainNode[]; now: number; id: string },
): SaveResult {
  const name = normalizeDesignName(input.name);
  if (!name) return { ok: false, reason: "Name the design before saving it." };
  if (input.chain.length === 0) return { ok: false, reason: "The canvas is empty — nothing to save." };

  const existing = list.find((design) => sameName(design.name, name));
  if (!existing && list.length >= MAX_SAVED_DESIGNS) {
    return {
      ok: false,
      reason: `The library holds ${MAX_SAVED_DESIGNS} designs. Delete one to save another.`,
    };
  }

  const saved: SavedDesign = {
    id: existing?.id ?? input.id,
    name,
    token: encodeChain(input.chain),
    blocks: input.chain.length,
    accent: settledShape(input.chain) ?? "token",
    updatedAt: input.now,
  };
  const rest = list.filter((design) => design.id !== saved.id);
  return { ok: true, list: sortNewestFirst([saved, ...rest]), saved, replaced: Boolean(existing) };
}

export function renameDesign(
  list: readonly SavedDesign[],
  id: string,
  rawName: string,
  now: number,
): SaveResult {
  const name = normalizeDesignName(rawName);
  const target = list.find((design) => design.id === id);
  if (!target) return { ok: false, reason: "That design is no longer in the library." };
  if (!name) return { ok: false, reason: "A design needs a name." };
  const clash = list.find((design) => design.id !== id && sameName(design.name, name));
  if (clash) return { ok: false, reason: `“${clash.name}” already exists — pick another name.` };
  const saved: SavedDesign = { ...target, name, updatedAt: now };
  return {
    ok: true,
    list: sortNewestFirst(list.map((design) => (design.id === id ? saved : design))),
    saved,
    replaced: true,
  };
}

export function removeDesign(list: readonly SavedDesign[], id: string): SavedDesign[] {
  return list.filter((design) => design.id !== id);
}

/** Decode an entry back into placeable nodes; null if the token no longer parses. */
export function decodeSavedDesign(design: SavedDesign): ChainNode[] | null {
  const chain = decodeChain(design.token);
  return chain && chain.length > 0 ? chain : null;
}

/* ------------------------------------------------------------------ */
/* Storage: the only impure edge, guarded on both directions.          */
/* ------------------------------------------------------------------ */

function isSavedDesign(value: unknown): value is SavedDesign {
  if (typeof value !== "object" || value === null) return false;
  const design = value as Record<string, unknown>;
  return (
    typeof design.id === "string" &&
    design.id.length > 0 &&
    typeof design.name === "string" &&
    design.name.length > 0 &&
    typeof design.token === "string" &&
    design.token.length > 0 &&
    typeof design.blocks === "number" &&
    typeof design.updatedAt === "number" &&
    typeof design.accent === "string"
  );
}

export function readDesignLibrary(): SavedDesign[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Entries are validated one by one: a single corrupt row costs itself,
    // not the library.
    return sortNewestFirst(parsed.filter(isSavedDesign)).slice(0, MAX_SAVED_DESIGNS);
  } catch {
    return [];
  }
}

export function writeDesignLibrary(list: readonly SavedDesign[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota or privacy mode: the in-memory library still works this session;
    // persisting it is best-effort by design.
  }
}
