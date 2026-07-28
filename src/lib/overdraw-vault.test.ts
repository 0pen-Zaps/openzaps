import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import { markRevealed, pendingSeals, readSealedDraws, saveSealedDraw, type SealedDraw } from "@/lib/overdraw";

/**
 * The salt vault is the last line of defence against the one mistake that costs
 * an entry, and it is the ONLY signal on the surface that needs neither a
 * connected wallet nor a working RPC. Round 1 of the live game was lost because
 * every other signal was gated on both.
 */

const GAME = "0xb1C9e106a85Ad26603BA3AC89fFa4bE29E6C5336" as Address;
const OTHER_GAME = "0x9941dD72373429C36F82D888dbcbab080038f033" as Address;
const PLAYER = "0x5a52D4B820Ae7F02880d270562950918ACb14aA2" as Address;
const CHAIN = 4663;

function seal(round: string, over: Partial<SealedDraw> = {}): SealedDraw {
  return {
    chainId: CHAIN,
    game: GAME,
    round,
    player: PLAYER,
    draw: 2_500,
    salt: `0x${"11".repeat(32)}` as Hex,
    commitment: `0x${"22".repeat(32)}` as Hex,
    sealedAt: 1_785_000_000_000 + Number(round),
    ...over,
  };
}

// jsdom is not configured for this suite (vitest runs in node), so stand up the
// minimum localStorage the vault touches.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("pendingSeals", () => {
  it("is empty when nothing was ever sealed", () => {
    expect(pendingSeals(CHAIN, GAME)).toEqual([]);
  });

  it("returns a sealed draw that was never revealed", () => {
    saveSealedDraw(seal("2"));
    const pending = pendingSeals(CHAIN, GAME);
    expect(pending).toHaveLength(1);
    expect(pending[0].round).toBe("2");
  });

  it("drops a seal once the reveal is confirmed", () => {
    const entry = seal("2");
    saveSealedDraw(entry);
    markRevealed(entry, Date.now());
    expect(pendingSeals(CHAIN, GAME)).toEqual([]);
    // The record itself survives — only the nagging stops.
    expect(readSealedDraws()).toHaveLength(1);
  });

  it("ignores seals for another game or another chain", () => {
    saveSealedDraw(seal("2", { game: OTHER_GAME }));
    saveSealedDraw(seal("2", { chainId: 1 }));
    expect(pendingSeals(CHAIN, GAME)).toEqual([]);
  });

  it("matches the game address case-insensitively", () => {
    // The vault stores whatever the caller wrote; a checksum mismatch must not
    // silently hide a pending seal.
    saveSealedDraw(seal("2", { game: GAME.toLowerCase() as Address }));
    expect(pendingSeals(CHAIN, GAME)).toHaveLength(1);
  });

  it("does not need a wallet address — it is not filtered by player", () => {
    // This is the whole point: a locked or switched wallet must not hide it.
    saveSealedDraw(seal("2", { player: OTHER_GAME as Address }));
    expect(pendingSeals(CHAIN, GAME)).toHaveLength(1);
  });

  it("returns newest first when several rounds are pending", () => {
    saveSealedDraw(seal("2"));
    saveSealedDraw(seal("3"));
    expect(pendingSeals(CHAIN, GAME).map((s) => s.round)).toEqual(["3", "2"]);
  });

  it("survives a corrupt vault rather than throwing", () => {
    (globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem(
      "openzaps:overdraw:sealed:v1",
      "{not json",
    );
    expect(pendingSeals(CHAIN, GAME)).toEqual([]);
  });
});
