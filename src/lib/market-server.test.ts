import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TOKEN_LAUNCH } from "@/lib/config";
import { FEE_REWARDS_MANIFEST } from "@/lib/rewards";
import { parseTokenMarketPulse } from "@/lib/market-server";

function fixture(): unknown {
  return {
    pairs: [{
      chainId: "robinhood",
      pairAddress: TOKEN_LAUNCH.primaryPair,
      baseToken: { address: TOKEN_LAUNCH.contract, symbol: "0xZAPS" },
      quoteToken: { address: FEE_REWARDS_MANIFEST.weth, symbol: "WETH" },
      volume: { h24: 44_718.81 },
      txns: { h24: { buys: 121, sells: 279 } },
      liquidity: { usd: 76_908.36 },
      priceUsd: "0.000001092",
    }],
  };
}

describe("0xZAPS market pulse", () => {
  it("accepts only the canonical pair and preserves the rolling market figures", () => {
    expect(parseTokenMarketPulse(fixture(), "2026-08-20T23:00:00.000Z")).toMatchObject({
      pair: TOKEN_LAUNCH.primaryPair,
      source: "DEX Screener",
      window: "rolling-24h",
      h24VolumeUsd: 44_718.81,
      h24Buys: 121,
      h24Sells: 279,
      liquidityUsd: 76_908.36,
      priceUsd: "0.000001092",
    });
  });

  it("rejects a substituted pair, token, or malformed market number", () => {
    const wrongPair = fixture() as { pairs: Array<Record<string, unknown>> };
    wrongPair.pairs[0].pairAddress = `0x${"11".repeat(32)}`;
    expect(() => parseTokenMarketPulse(wrongPair)).toThrow(/canonical 0xZAPS market/);

    const wrongToken = fixture() as { pairs: Array<Record<string, unknown>> };
    wrongToken.pairs[0].baseToken = { address: "0x0000000000000000000000000000000000000001" };
    expect(() => parseTokenMarketPulse(wrongToken)).toThrow(/canonical 0xZAPS market/);

    const malformed = fixture() as { pairs: Array<Record<string, unknown>> };
    malformed.pairs[0].volume = { h24: Number.NaN };
    expect(() => parseTokenMarketPulse(malformed)).toThrow(/canonical 0xZAPS market/);
  });
});
