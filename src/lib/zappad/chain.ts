import type { Address } from "viem";

import {
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  robinhoodChain,
} from "@/lib/robinhood";

export { ROBINHOOD_CHAIN_ID, robinhoodChain };
export const EXPLORER_URL = ROBINHOOD_EXPLORER_URL;
export const OFFICIAL_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const WETH_ADDRESS = ROBINHOOD_ASSETS.weth as Address;
export const USDG_ADDRESS = ROBINHOOD_ASSETS.usdg as Address;

export const PAIR_ASSETS = [
  {
    address: WETH_ADDRESS,
    symbol: "WETH",
    displaySymbol: "ETH",
    decimals: 18,
    kind: "native" as const,
    marketCapPresets: [0.5, 5, 25, 100],
  },
  {
    address: USDG_ADDRESS,
    symbol: "USDG",
    displaySymbol: "USDG",
    decimals: 6,
    kind: "erc20" as const,
    marketCapPresets: [1_000, 5_000, 25_000, 100_000],
  },
] as const;

export const FEE_TIERS = [
  { fee: 500, spacing: 10, label: "0.05%", hint: "Tight" },
  { fee: 3_000, spacing: 60, label: "0.30%", hint: "Balanced" },
  { fee: 10_000, spacing: 200, label: "1.00%", hint: "Volatile" },
] as const;

export function explorerAddress(address: Address | string) {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTransaction(hash: string) {
  return `${EXPLORER_URL}/tx/${hash}`;
}
