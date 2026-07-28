import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { BOUNDED_SWAP_IDS } from "@/lib/chains";
import { CHAIN, CONTRACTS, LINKS, TOKEN, TOKEN_LAUNCH } from "@/lib/config";
import {
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
  openZapV3_2Configured,
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

  // Guards a class of bug that shipped once: a hardcoded default with a bad EIP-55 checksum. viem's
  // readContract and typed-data encoding reject a mis-checksummed address at CALL time (never at
  // build), so it slips past types, tsc, and lint — and only fails when a wallet or RPC touches it.
  // A bad literal now collapses to zeroAddress via optionalAddress; both prongs below catch it.
  it("every OpenZap v3 / v3.1 contract address is configured and EIP-55 checksummed", () => {
    for (const [label, contracts] of [
      ["v3", OPENZAP_V3_CONTRACTS],
      ["v3.1", OPENZAP_V3_1_CONTRACTS],
    ] as const) {
      for (const [key, addr] of Object.entries(contracts)) {
        expect(addr, `${label}.${key} must be configured (non-zero)`).not.toBe(zeroAddress);
        expect(getAddress(addr), `${label}.${key} must be a valid EIP-55 checksum`).toBe(addr);
      }
    }
  });

  // v3.2 (stacking) is intentionally NOT in the loop above: it is unbuilt on-chain, so its addresses
  // are all zero by design. This test pins the fail-closed posture — and inverts into a deployment
  // checklist. When v3.2 ships, this test starts failing, which is the signal to move it into the
  // checksummed loop above and gate the Automate stacking option on `openZapV3_2Configured()`.
  it("v3.2 stays gated off until a verified deployment is configured", () => {
    expect(openZapV3_2Configured()).toBe(false);
    for (const [key, addr] of Object.entries(OPENZAP_V3_2_CONTRACTS)) {
      expect(addr, `v3.2.${key} must stay zero until deployed`).toBe(zeroAddress);
    }
  });

  it("the internal buy link opens the deployed aeWETH to 0xZAPS route", () => {
    expect(LINKS.buyWithOpenZaps).toBe(`/zap?view=sign&route=${BOUNDED_SWAP_IDS[0]}`);
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
