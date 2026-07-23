import { describe, expect, it } from "vitest";

import { makeNode, type ChainNode } from "@/lib/blocks";
import {
  MAX_DESIGN_NAME,
  MAX_SAVED_DESIGNS,
  decodeSavedDesign,
  normalizeDesignName,
  removeDesign,
  renameDesign,
  upsertDesign,
  type SavedDesign,
} from "@/lib/designs";

function chain(...blockIds: string[]): ChainNode[] {
  return blockIds.map((blockId, index) => makeNode(blockId, `t${index}`));
}

const SWAP = chain("wallet-balance", "guard-slippage", "swap", "send");
const LP = chain("wallet-balance", "guard-slippage", "add-liquidity", "hold-lp");

function save(
  list: SavedDesign[],
  name: string,
  input: { chain?: ChainNode[]; now?: number; id?: string } = {},
): SavedDesign[] {
  const result = upsertDesign(list, {
    name,
    chain: input.chain ?? SWAP,
    now: input.now ?? 1000,
    id: input.id ?? `id-${name}`,
  });
  if (!result.ok) throw new Error(`expected save to succeed: ${result.reason}`);
  return result.list;
}

describe("normalizeDesignName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeDesignName("  my   weekly\tDCA  ")).toBe("my weekly DCA");
  });

  it("clamps to the display limit", () => {
    expect(normalizeDesignName("x".repeat(MAX_DESIGN_NAME + 20))).toHaveLength(MAX_DESIGN_NAME);
  });
});

describe("upsertDesign", () => {
  it("saves a named design with the chain's real facts", () => {
    const result = upsertDesign([], { name: "Weekly buy", chain: SWAP, now: 42, id: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.saved).toMatchObject({ id: "a", name: "Weekly buy", blocks: 4, updatedAt: 42 });
    expect(result.replaced).toBe(false);
    // The stored token round-trips to the same chain.
    expect(decodeSavedDesign(result.saved)?.map((node) => node.blockId)).toEqual(
      SWAP.map((node) => node.blockId),
    );
  });

  it("records the chain's output shape for the accent swatch", () => {
    const result = upsertDesign([], { name: "LP", chain: LP, now: 1, id: "a" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.saved.accent).toBe("lp");
  });

  it("refuses an empty name and an empty canvas", () => {
    expect(upsertDesign([], { name: "   ", chain: SWAP, now: 1, id: "a" }).ok).toBe(false);
    expect(upsertDesign([], { name: "ok", chain: [], now: 1, id: "a" }).ok).toBe(false);
  });

  it("replaces a same-name design case-insensitively, keeping its identity", () => {
    const list = save([], "Weekly buy", { id: "original" });
    const result = upsertDesign(list, { name: "WEEKLY BUY", chain: LP, now: 2000, id: "ignored" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replaced).toBe(true);
    expect(result.list).toHaveLength(1);
    expect(result.saved.id).toBe("original");
    expect(result.saved.blocks).toBe(LP.length);
  });

  it("refuses a new name once the library is full, without evicting anything", () => {
    let list: SavedDesign[] = [];
    for (let i = 0; i < MAX_SAVED_DESIGNS; i += 1) list = save(list, `design ${i}`, { now: i });
    const result = upsertDesign(list, { name: "one more", chain: SWAP, now: 99, id: "z" });
    expect(result.ok).toBe(false);
    expect(list).toHaveLength(MAX_SAVED_DESIGNS);
    // Overwriting an existing name still works at capacity.
    const overwrite = upsertDesign(list, { name: "design 3", chain: LP, now: 99, id: "z" });
    expect(overwrite.ok).toBe(true);
  });

  it("keeps the list newest-first", () => {
    let list = save([], "old", { now: 10 });
    list = save(list, "new", { now: 20 });
    list = save(list, "middle", { now: 15 });
    expect(list.map((design) => design.name)).toEqual(["new", "middle", "old"]);
  });
});

describe("renameDesign", () => {
  it("renames in place and refuses collisions with other designs", () => {
    let list = save([], "alpha", { id: "a", now: 1 });
    list = save(list, "beta", { id: "b", now: 2 });
    const renamed = renameDesign(list, "a", "gamma", 3);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.list.find((design) => design.id === "a")?.name).toBe("gamma");

    const clash = renameDesign(renamed.list, "a", "BETA", 4);
    expect(clash.ok).toBe(false);
    // Renaming to its own current name is not a collision.
    expect(renameDesign(renamed.list, "a", "gamma", 5).ok).toBe(true);
  });

  it("refuses a vanished id", () => {
    expect(renameDesign([], "ghost", "name", 1).ok).toBe(false);
  });
});

describe("removeDesign", () => {
  it("removes exactly the given id", () => {
    let list = save([], "alpha", { id: "a" });
    list = save(list, "beta", { id: "b" });
    expect(removeDesign(list, "a").map((design) => design.id)).toEqual(["b"]);
    expect(removeDesign(list, "missing")).toHaveLength(2);
  });
});

describe("decodeSavedDesign", () => {
  it("returns null for a token that no longer parses", () => {
    const list = save([], "ok");
    const broken = { ...list[0], token: "not-a-token" };
    expect(decodeSavedDesign(broken)).toBeNull();
  });
});
