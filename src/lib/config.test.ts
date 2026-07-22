import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { CHAIN, CONTRACTS, TOKEN, TOKEN_LAUNCH } from "@/lib/config";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_LIQUIDITY,
} from "@/lib/robinhood";

function readPublicJson(name: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), "public", name), "utf8"));
}

describe("site config stays consistent with onchain constants", () => {
  it("token contract and chain match the live route constants", () => {
    expect(getAddress(TOKEN_LAUNCH.contract)).toBe(getAddress(ROBINHOOD_ASSETS.zaps));
    expect(TOKEN_LAUNCH.chainId).toBe(ROBINHOOD_CHAIN_ID);
    expect(CHAIN.id).toBe(ROBINHOOD_CHAIN_ID);
    expect(TOKEN.decimals).toBe(18);
  });

  it("config CONTRACTS match the deployed OpenZap addresses", () => {
    expect(getAddress(CONTRACTS.factory)).toBe(getAddress(OPENZAP_CONTRACTS.factory));
  });

  it("public token-metadata.json agrees with config", () => {
    const metadata = readPublicJson("token-metadata.json") as {
      token: { contract: string; chainId: number; decimals: number; symbol: string };
    };
    expect(getAddress(metadata.token.contract)).toBe(getAddress(TOKEN_LAUNCH.contract));
    expect(metadata.token.chainId).toBe(ROBINHOOD_CHAIN_ID);
    expect(metadata.token.decimals).toBe(TOKEN.decimals);
    expect(metadata.token.symbol).toBe(TOKEN.symbol);
  });

  it("public tokenlist.json agrees with config", () => {
    const list = readPublicJson("tokenlist.json") as {
      tokens: Array<{ address: string; chainId: number; decimals: number; symbol: string }>;
    };
    const zaps = list.tokens.find((t) => getAddress(t.address) === getAddress(TOKEN_LAUNCH.contract));
    expect(zaps).toBeDefined();
    expect(zaps?.chainId).toBe(ROBINHOOD_CHAIN_ID);
    expect(zaps?.decimals).toBe(TOKEN.decimals);
  });

  it("public tokenlist.json satisfies the Uniswap token-list schema constraints", () => {
    const list = readPublicJson("tokenlist.json") as {
      keywords?: string[];
      tokens: Array<{ extensions?: Record<string, unknown> }>;
    };

    // The schema caps extension string values at 42 chars, so long URLs belong
    // in token-metadata.json rather than here.
    for (const token of list.tokens) {
      for (const [key, value] of Object.entries(token.extensions ?? {})) {
        if (typeof value === "string") {
          expect(`${key}=${value.length}`).toBe(`${key}=${Math.min(value.length, 42)}`);
        }
      }
    }

    for (const keyword of list.keywords ?? []) {
      expect(keyword).toMatch(/^[\w ]+$/);
    }
  });

  it("pool id is pinned to the documented Robinhood v4 pool", () => {
    expect(ROBINHOOD_LIQUIDITY.poolId).toBe("0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573");
  });
});
