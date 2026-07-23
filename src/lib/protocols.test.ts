import { describe, expect, it } from "vitest";

import { BLOCKS, defaultParams, getBlock } from "@/lib/blocks";
import { PROTOCOL_IDS, protocolName, protocolsForAction, type ProtocolId } from "@/lib/protocols";

/** A block's protocols at its catalog defaults, as bare ids. */
function ids(blockId: string, params?: Record<string, unknown>): ProtocolId[] {
  const block = getBlock(blockId);
  const defaults = block ? defaultParams(block) : {};
  return protocolsForAction(blockId, { ...defaults, ...params }).map((protocol) => protocol.id);
}

describe("protocolsForAction", () => {
  it("badges every action block in the catalog", () => {
    // A new action landing in the catalog without a protocol mapping should
    // fail here, not ship as the one card on the canvas with no badge.
    for (const block of BLOCKS.filter((entry) => entry.kind === "action")) {
      expect(ids(block.id).length, block.id).toBeGreaterThan(0);
    }
  });

  it("badges nothing that is not an action, except lp-position", () => {
    // Guards constrain, sinks settle, and plain sources draw from the wallet —
    // none of them touch a protocol. `lp-position` is the one source that
    // starts inside one: its ozRANGE shares are OpenZaps vault shares.
    for (const block of BLOCKS.filter((entry) => entry.kind !== "action")) {
      if (block.id === "lp-position") continue;
      expect(ids(block.id), block.id).toEqual([]);
    }
    expect(ids("lp-position")).toEqual(["openzaps-vault"]);
  });

  it("follows the swap venue param", () => {
    expect(ids("swap", { venue: "Uniswap v4" })).toEqual(["uniswap-v4"]);
    expect(ids("swap", { venue: "Uniswap v3" })).toEqual(["uniswap-v3"]);
    expect(ids("swap", { venue: "Aerodrome" })).toEqual(["aerodrome"]);
  });

  it("falls back to the one deployed venue when the swap names none", () => {
    expect(protocolsForAction("swap", {}).map((protocol) => protocol.id)).toEqual(["uniswap-v4"]);
    expect(ids("swap", { venue: "SushiSwap" })).toEqual(["uniswap-v4"]);
    expect(ids("swap", { venue: 42 })).toEqual(["uniswap-v4"]);
  });

  it("follows the supply market param, defaulting to Morpho", () => {
    expect(ids("supply", { market: "ZapVault" })).toEqual(["openzaps-vault"]);
    expect(ids("supply", { market: "Morpho" })).toEqual(["morpho"]);
    expect(ids("supply", { market: "Aave v3" })).toEqual(["aave"]);
    expect(ids("supply", { market: "Compound v3" })).toEqual(["compound"]);
    expect(protocolsForAction("supply", {}).map((protocol) => protocol.id)).toEqual(["morpho"]);
    expect(ids("supply", { market: "Euler" })).toEqual(["morpho"]);
  });

  it("shows both the venue and the custodian on the liquidity blocks", () => {
    // The ZapRangeVault is an OpenZaps primitive that LPs into a Uniswap v4
    // pool — hiding either half of that would mis-state where the funds sit.
    expect(ids("add-liquidity")).toEqual(["uniswap-v4", "openzaps-vault"]);
    expect(ids("remove-liquidity")).toEqual(["uniswap-v4", "openzaps-vault"]);
  });

  it("maps the single-venue actions to their protocols", () => {
    expect(ids("borrow")).toEqual(["aave"]);
    expect(ids("draw-debt")).toEqual(["aave"]);
    expect(ids("unwrap")).toEqual(["wrapped-native"]);
    expect(ids("bridge")).toEqual(["canonical-bridge"]);
    expect(ids("stake")).toEqual(["uniswap-v4"]);
    expect(ids("accrue")).toEqual(["uniswap-v4"]);
    expect(ids("harvest")).toEqual(["uniswap-v4"]);
  });

  it("returns nothing for ids the catalog has never heard of", () => {
    expect(protocolsForAction("teleport", {})).toEqual([]);
    expect(protocolsForAction("", {})).toEqual([]);
    expect(protocolsForAction("SWAP", {})).toEqual([]);
  });

  it("returns the display name alongside every id", () => {
    for (const block of BLOCKS) {
      for (const protocol of protocolsForAction(block.id, defaultParams(block))) {
        expect(protocol.name).toBe(protocolName(protocol.id));
      }
    }
  });
});

describe("protocolName", () => {
  it("names every protocol id", () => {
    expect(PROTOCOL_IDS.length).toBe(9);
    for (const id of PROTOCOL_IDS) {
      const name = protocolName(id);
      expect(typeof name, id).toBe("string");
      expect(name.length, id).toBeGreaterThan(0);
    }
  });

  it("keeps ids unique", () => {
    expect(new Set(PROTOCOL_IDS).size).toBe(PROTOCOL_IDS.length);
  });
});
