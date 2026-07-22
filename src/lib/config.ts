// Canonical production protocol and token configuration.

export const TOKEN = {
  name: "OpenZaps",
  symbol: "0xZAPS",
  decimals: 18,
} as const;

const tokenContract = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07";

export const TOKEN_LAUNCH = {
  status: "Live",
  venue: "Clanker",
  version: "V4",
  network: "Robinhood Chain",
  contract: tokenContract,
  tradeUrl: `https://www.clanker.world/clanker/${tokenContract}`,
  explorer: "https://robinhoodchain.blockscout.com",
  contractUrl: `https://robinhoodchain.blockscout.com/token/${tokenContract}`,
} as const;

/** The canonical 0xZAPS buy/trade page. */
export function buyUrl(): string {
  return TOKEN_LAUNCH.tradeUrl;
}

export const CHAIN = {
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Robinhood Chain",
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663),
  explorer: process.env.NEXT_PUBLIC_EXPLORER ?? "https://robinhoodchain.blockscout.com",
} as const;

/** Live protocol addresses on Robinhood Chain mainnet (4663). */
export const CONTRACTS = {
  factory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4",
  implementation: "0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A",
  adapterRegistry: process.env.NEXT_PUBLIC_ADAPTER_REGISTRY ?? "0x9E56e444f490C00A6277326A47Cb462E12dF1f17",
  tokenAllowlist: process.env.NEXT_PUBLIC_TOKEN_ALLOWLIST ?? "0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B",
  swapAdapter: process.env.NEXT_PUBLIC_SWAP_ADAPTER ?? "0x04f62dA4b51a010eFa32aa81569169C47AEd602C",
} as const;

/** Historical Base v1 deployment; not used by the production app. */
export const HISTORICAL_BASE_CONTRACTS = {
  chainId: 8453,
  factory: "0xc7C5897e4738a157731c2F93b1d73Db9926E926C",
  implementation: "0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e",
  adapterRegistry: "0x8d62b619daD575704Ba2560CF828aCab7642347F",
  tokenAllowlist: "0x0E6608d6b9e485550289755176173c4B6008CF12",
} as const;

/** Whether the protocol contracts are deployed on `CHAIN`. */
export function contractsLive(): boolean {
  return Object.values(CONTRACTS).every((address) => address.startsWith("0x") && address.length === 42);
}

/** Whether the canonical 0xZAPS contract is configured (drives buy/trade UI). */
export function tokenLive(): boolean {
  return TOKEN_LAUNCH.contract.length > 0;
}

/** Block-explorer link for an address. */
export function explorer(addr: string): string {
  return `${CHAIN.explorer}/address/${addr}`;
}

export const LINKS = {
  github: "https://github.com/nodar/openzaps",
  clanker: TOKEN_LAUNCH.tradeUrl,
  tokenExplorer: TOKEN_LAUNCH.contractUrl,
  buy: buyUrl(),
} as const;

export const STATUS = {
  // Honest posture — see docs/invariant-spec.md production-readiness gate.
  preAudit: true,
  network: CHAIN.name,
} as const;
