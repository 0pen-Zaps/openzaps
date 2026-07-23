import { createPublicClient, http } from "viem";

import {
  RANGE_VAULT_ADDRESS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_RPC_URL,
  rangeVaultAbi,
  robinhoodChain,
  zapVaultAbi,
} from "@/lib/robinhood";

/**
 * Live, measured vault state for the protocol pulse — nothing here is derived,
 * projected, or cached beyond the page's own ISR window.
 *
 * Every number is a direct read: the range vault's position liquidity and
 * share supply from its own storage, the underlying amounts from
 * `previewRedeem(totalSupply)` (what ALL shares would redeem for at the
 * current pool price — principal plus realised fee reserves, valued by the
 * pool, not by us), the burned-share count from `balanceOf(0xdead)`, and the
 * ozUSDG vault's assets from `totalAssets()`. There is deliberately NO yield,
 * APR, or USD figure: the range vault earns pool fees it does not project,
 * and the ozUSDG vault earns nothing at all.
 *
 * Fail closed: any read failing returns null for its whole card, and callers
 * render "unavailable" — never a fabricated zero.
 */

const DEAD = "0x000000000000000000000000000000000000dEaD" as const;

export type RangeVaultPulse = {
  /** The position's liquidity in the pool's own L units. */
  positionLiquidity: bigint;
  /** Total ozRANGE shares (18 dp). */
  totalShares: bigint;
  /** Shares provably burned to 0xdead (the seed, and anything sent after). */
  burnedShares: bigint;
  /** What every share together redeems for right now: [aeWETH, USDG]. */
  holdings: readonly [bigint, bigint];
};

export type ZapVaultPulse = {
  /** USDG (6 dp) the ozUSDG receipt vault custodies. */
  totalAssets: bigint;
  /** ozUSDG shares (9 dp) in circulation. */
  totalSupply: bigint;
};

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

/** Throws on any RPC failure — callers decide how to fail closed. */
export async function fetchRangeVaultPulse(): Promise<RangeVaultPulse> {
  const [positionLiquidity, totalShares, burnedShares] = await Promise.all([
    client.readContract({ address: RANGE_VAULT_ADDRESS, abi: rangeVaultAbi, functionName: "positionLiquidity" }),
    client.readContract({ address: RANGE_VAULT_ADDRESS, abi: rangeVaultAbi, functionName: "totalSupply" }),
    client.readContract({
      address: RANGE_VAULT_ADDRESS,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
      ] as const,
      functionName: "balanceOf",
      args: [DEAD],
    }),
  ]);
  const holdings =
    totalShares === 0n
      ? ([0n, 0n] as const)
      : await client.readContract({
          address: RANGE_VAULT_ADDRESS,
          abi: rangeVaultAbi,
          functionName: "previewRedeem",
          args: [totalShares],
        });
  return {
    positionLiquidity,
    totalShares,
    burnedShares,
    holdings: [holdings[0], holdings[1]] as const,
  };
}

/** Throws on any RPC failure — callers decide how to fail closed. */
export async function fetchZapVaultPulse(): Promise<ZapVaultPulse> {
  const [totalAssets, totalSupply] = await Promise.all([
    client.readContract({
      address: ROBINHOOD_ASSETS.ozusdg,
      abi: [
        {
          type: "function",
          name: "totalAssets",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
      ] as const,
      functionName: "totalAssets",
    }),
    client.readContract({ address: ROBINHOOD_ASSETS.ozusdg, abi: zapVaultAbi, functionName: "totalSupply" }),
  ]);
  return { totalAssets, totalSupply };
}

/** Format a raw token amount for the pulse cards: trimmed, never padded. */
export function formatPulseAmount(value: bigint, decimals: number, maxFraction = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
