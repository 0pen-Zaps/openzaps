// Central launch configuration. Values that only exist after deployment (token id, contract
// addresses) are env-driven so the deploy step can fill them in without code changes.

export const TOKEN = {
  name: "OpenZaps",
  symbol: "0xZAPS",
  decimals: 18,
} as const;

export const POOLFANS = {
  tokenId: process.env.NEXT_PUBLIC_POOLFANS_TOKEN_ID ?? "",
  launchpad: "https://www.clanker.world/clanker/0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
} as const;

/** The canonical 0xZAPS buy/trade page. */
export function buyUrl(): string {
  return POOLFANS.launchpad;
}

export const CHAIN = {
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Base",
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 8453),
  explorer: process.env.NEXT_PUBLIC_EXPLORER ?? "https://basescan.org",
} as const;

/** Deployed protocol + token addresses. Protocol is live on Base mainnet (8453). */
export const CONTRACTS = {
  token: process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "", // 0xZAPS — set once launched on pool.fans
  factory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? "0xc7C5897e4738a157731c2F93b1d73Db9926E926C",
  implementation: "0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e",
  adapterRegistry: process.env.NEXT_PUBLIC_ADAPTER_REGISTRY ?? "0x8d62b619daD575704Ba2560CF828aCab7642347F",
  tokenAllowlist: process.env.NEXT_PUBLIC_TOKEN_ALLOWLIST ?? "0x0E6608d6b9e485550289755176173c4B6008CF12",
} as const;

/** Whether the protocol contracts are deployed on `CHAIN`. */
export function contractsLive(): boolean {
  return CONTRACTS.factory.length > 0;
}

/** Whether the 0xZAPS token has launched on pool.fans (drives buy/trade UI). */
export function tokenLive(): boolean {
  return POOLFANS.tokenId.length > 0 || CONTRACTS.token.length > 0;
}

/** Block-explorer link for an address. */
export function explorer(addr: string): string {
  return `${CHAIN.explorer}/address/${addr}`;
}

export const LINKS = {
  github: "https://github.com/nodar/openzaps",
  poolfans: POOLFANS.launchpad,
  buy: buyUrl(),
} as const;

export const STATUS = {
  // Honest posture — see docs/invariant-spec.md production-readiness gate.
  preAudit: true,
  network: CHAIN.name,
} as const;
