import { describe, expect, it } from "vitest";
import { parseEther, parseUnits, type Address } from "viem";

import {
  CONVERTIBLE_FEE_ASSETS,
  POT_FEE_ASSETS,
  STRANDED_FEE_ASSETS,
  isConvertible,
  conversionFloor,
  hasPendingConversion,
  lifetimeAwarded,
  lifetimeZapsBought,
  ticketShare,
  toPendingAsset,
  type PotAward,
  type PotConversion,
} from "@/lib/pot";
import { ROBINHOOD_ASSETS } from "@/lib/robinhood";

const CALLER = "0x11DB3AF89b626ab1e09EDb8223af836D1Bee9347" as Address;
const TX = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

function conversion(overrides: Partial<PotConversion> = {}): PotConversion {
  return {
    round: "1",
    caller: CALLER,
    assetIn: ROBINHOOD_ASSETS.weth,
    symbolIn: "aeWETH",
    amountIn: parseEther("0.01").toString(),
    zapsOut: parseEther("1000").toString(),
    txHash: TX(1),
    blockNumber: "100",
    ...overrides,
  };
}

describe("lifetime totals", () => {
  it("sums converted 0xZAPS across every conversion", () => {
    const total = lifetimeZapsBought([
      conversion(),
      conversion({ zapsOut: parseEther("250.5").toString() }),
    ]);
    expect(total).toBe(parseEther("1250.5"));
  });

  it("sums awarded prizes and returns zero for an empty history", () => {
    const awards: PotAward[] = [
      { round: "1", winner: CALLER, prize: parseEther("2166.65").toString(), txHash: TX(2), blockNumber: "200" },
    ];
    expect(lifetimeAwarded(awards)).toBe(parseEther("2166.65"));
    expect(lifetimeAwarded([])).toBe(0n);
    expect(lifetimeZapsBought([])).toBe(0n);
  });
});

describe("ticketShare", () => {
  // The share is contribution WEIGHT, never a probability: tickets are raw fee
  // amounts summed across assets of different decimals. These tests pin the
  // arithmetic; the UI is responsible for labelling it honestly.
  it("is the wallet's fraction of the round's tickets", () => {
    expect(ticketShare(parseEther("25").toString(), parseEther("100").toString())).toBeCloseTo(0.25, 6);
    expect(ticketShare(parseEther("100").toString(), parseEther("100").toString())).toBeCloseTo(1, 6);
  });

  it("is null when it cannot be stated — no wallet, or an empty round", () => {
    expect(ticketShare(null, parseEther("100").toString())).toBeNull();
    expect(ticketShare(parseEther("1").toString(), "0")).toBeNull();
  });

  it("is zero for a wallet with no tickets in a round that has some", () => {
    expect(ticketShare("0", parseEther("100").toString())).toBe(0);
  });

  it("keeps precision on a tiny share instead of rounding it to nothing", () => {
    const share = ticketShare(parseEther("1").toString(), parseEther("1000000").toString());
    expect(share).not.toBeNull();
    expect(share).toBeGreaterThan(0);
  });
});

describe("conversionFloor", () => {
  it("applies the slippage band to the quote", () => {
    expect(conversionFloor(parseEther("1000"), 100)).toBe(parseEther("990"));
    expect(conversionFloor(parseEther("1000"), 0)).toBe(parseEther("1000"));
  });

  it("never returns a floor from a non-positive quote — buyZaps would accept anything", () => {
    expect(conversionFloor(0n, 100)).toBe(0n);
    expect(conversionFloor(-1n, 100)).toBe(0n);
  });

  it("clamps a nonsense band instead of underflowing", () => {
    expect(conversionFloor(parseEther("1000"), 20_000)).toBeGreaterThanOrEqual(0n);
    expect(conversionFloor(parseEther("1000"), -50)).toBe(parseEther("1000"));
  });
});

describe("pending fee assets", () => {
  it("reads a balance at the asset's own decimals, not a hardcoded 18", () => {
    // USDG is 6dp: treating it as 18 would understate the pending balance by 10^12.
    const usdg = toPendingAsset(ROBINHOOD_ASSETS.usdg, parseUnits("25", 6));
    expect(usdg.symbol).toBe("USDG");
    expect(usdg.decimals).toBe(6);
    expect(usdg.balance).toBe(parseUnits("25", 6).toString());
  });

  it("detects whether any asset is actually awaiting conversion", () => {
    const empty = POT_FEE_ASSETS.map((asset) => toPendingAsset(asset, 0n));
    expect(hasPendingConversion(empty)).toBe(false);
    expect(hasPendingConversion([...empty, toPendingAsset(ROBINHOOD_ASSETS.weth, 1n)])).toBe(true);
  });

  it("never lists 0xZAPS as pending — buyZaps reverts on the prize asset", () => {
    for (const asset of POT_FEE_ASSETS) {
      expect(asset.toLowerCase()).not.toBe(ROBINHOOD_ASSETS.zaps.toLowerCase());
    }
  });
});

describe("convertible vs stranded fee assets", () => {
  // The pot's BUY_ADAPTER is immutable and welded to the aeWETH/0xZAPS pool (verified
  // onchain: 0x04f62dA4… on both pots). Anything else it receives can never become
  // prize and can never leave — awardRound only transfers 0xZAPS and there is no
  // owner drain. Offering a convert button for those assets would be a button that
  // always reverts, on top of a false promise.
  it("treats only aeWETH as convertible", () => {
    expect(CONVERTIBLE_FEE_ASSETS).toEqual([ROBINHOOD_ASSETS.weth]);
    expect(isConvertible(ROBINHOOD_ASSETS.weth)).toBe(true);
  });

  it("treats every other fee asset as permanently stranded", () => {
    for (const asset of STRANDED_FEE_ASSETS) {
      expect(isConvertible(asset), asset).toBe(false);
    }
    expect(STRANDED_FEE_ASSETS).toContain(ROBINHOOD_ASSETS.usdg);
  });

  it("never claims the prize asset itself is convertible — buyZaps reverts on it", () => {
    expect(isConvertible(ROBINHOOD_ASSETS.zaps)).toBe(false);
    expect(POT_FEE_ASSETS).not.toContain(ROBINHOOD_ASSETS.zaps);
  });

  it("reads a balance for every asset, convertible or not, so nothing is hidden", () => {
    expect(POT_FEE_ASSETS).toEqual([...CONVERTIBLE_FEE_ASSETS, ...STRANDED_FEE_ASSETS]);
  });
});
