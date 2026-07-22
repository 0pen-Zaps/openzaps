// Central protocol and token configuration. Keep the Base protocol deployment separate from
// the 0xZAPS market, which launched through Clanker on Robinhood Chain.

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
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Base",
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 8453),
  explorer: process.env.NEXT_PUBLIC_EXPLORER ?? "https://basescan.org",
} as const;

/** Deployed protocol addresses on Base mainnet (8453). */
export const CONTRACTS = {
  factory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? "0xc7C5897e4738a157731c2F93b1d73Db9926E926C",
  implementation: "0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e",
  adapterRegistry: process.env.NEXT_PUBLIC_ADAPTER_REGISTRY ?? "0x8d62b619daD575704Ba2560CF828aCab7642347F",
  tokenAllowlist: process.env.NEXT_PUBLIC_TOKEN_ALLOWLIST ?? "0x0E6608d6b9e485550289755176173c4B6008CF12",
} as const;

/** Whether the protocol contracts are deployed on `CHAIN`. */
export function contractsLive(): boolean {
  return CONTRACTS.factory.length > 0;
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
  x: "https://x.com/0xzaps",
  clanker: TOKEN_LAUNCH.tradeUrl,
  tokenExplorer: TOKEN_LAUNCH.contractUrl,
  buy: buyUrl(),
} as const;

/** Official X (Twitter) handle, for twitter:site/creator card tags. */
export const X_HANDLE = "@0xzaps";

export const STATUS = {
  // Honest posture — see docs/invariant-spec.md production-readiness gate.
  preAudit: true,
  network: CHAIN.name,
} as const;
