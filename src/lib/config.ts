// Central launch configuration. Values that only exist after deployment (token id, contract
// addresses) are env-driven so the deploy step can fill them in without code changes.

export const TOKEN = {
  name: "OpenZaps",
  symbol: "0xZAPS",
  decimals: 18,
} as const;

export const POOLFANS = {
  // The token's home on the pool.fans tokenizer. `tokenId` is assigned at launch.
  tokenizerBase: "https://tokenizer.pool.fans/token",
  tokenId: process.env.NEXT_PUBLIC_POOLFANS_TOKEN_ID ?? "",
  launchpad: "https://pool.fans/openzaps",
} as const;

/** The buy/trade URL. Falls back to the tokenizer root until a token id is configured. */
export function buyUrl(): string {
  return POOLFANS.tokenId ? `${POOLFANS.tokenizerBase}/${POOLFANS.tokenId}` : "https://tokenizer.pool.fans";
}

export const CHAIN = {
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Base",
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 8453),
  explorer: process.env.NEXT_PUBLIC_EXPLORER ?? "https://basescan.org",
} as const;

/** Deployed protocol + token addresses. Empty until the deploy step wires them in. */
export const CONTRACTS = {
  token: process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "",
  factory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? "",
  adapterRegistry: process.env.NEXT_PUBLIC_ADAPTER_REGISTRY ?? "",
  tokenAllowlist: process.env.NEXT_PUBLIC_TOKEN_ALLOWLIST ?? "",
} as const;

/** Whether the protocol contracts are live on `CHAIN`. Drives "live" vs "preview" UI. */
export function isLive(): boolean {
  return CONTRACTS.factory.length > 0;
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
