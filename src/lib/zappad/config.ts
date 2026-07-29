import type { Address } from "viem";

export interface RuntimeConfig {
  launcherAddress: Address | null;
  deployBlock: number;
  readEnabled: boolean;
  chain: {
    id: number;
    name: string;
    nativeCurrency: {
      name: string;
      symbol: string;
      decimals: number;
    };
    explorerUrl: string;
    rpcPath: string;
  };
  pairedAssets: Array<{
    address: Address;
    symbol: string;
    decimals: number;
    kind: "native" | "erc20";
  }>;
  launchEnabled: boolean;
}
