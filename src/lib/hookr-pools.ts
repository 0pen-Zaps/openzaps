import { getAddress, isAddress, keccak256, encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";

/**
 * The Hookr liquidity slice: the HOOKR-quoted Uniswap v4 pools the Hookr
 * launchpad graduates, and the OpenZaps contracts that make "zap in", "zap
 * out" and "migrate" one signed step each.
 *
 * Every Hookr pool shares ONE hook (`HOOKR_HOOK`), a dynamic fee and tick
 * spacing 60, and pairs a launched token with HOOKR. A `HookedRangeVault`
 * per pool (deployed permissionlessly by `HookedRangeVaultFactory`) wraps a
 * full-range position as an ERC-20 share token; ONE deposit adapter and ONE
 * withdraw adapter serve every vault, taking the vault (or settlement asset)
 * as bounded, factory-verified step data.
 *
 * FAIL CLOSED, twice over. The three contracts are an all-or-nothing set
 * (`hookrLpContractsState()`), and each pool additionally needs its vault
 * address known — baked into `HOOKR_LP_POOLS` after the deploy is verified,
 * or supplied through `NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS` for a launch that
 * post-dates the last bake. A pool with no known vault resolves to no route.
 *
 * This module imports nothing from the rest of `src/lib` so `robinhood.ts`,
 * `chains.ts`, `routes.ts` and `blocks.ts` can all read it without a cycle.
 */

export const HOOKR_TOKEN: Address = getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c");
/** The Hookr launchpad's shared hook — hookr.fun/docs, verified with the launchpad source. */
export const HOOKR_HOOK: Address = getAddress("0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC");
export const HOOKR_LP_DYNAMIC_FEE = 0x800000;
export const HOOKR_LP_TICK_SPACING = 60;
export const HOOKR_LP_SHARE_DECIMALS = 18;
/** Catalog vocabulary: the `pool` param of the add-liquidity block. */
export const HOOKR_LP_POOL_PREFIX = "HOOKR/";
/** Catalog vocabulary: the share-token symbol prefix (`ozHR-<SYMBOL>`). */
export const HOOKR_LP_SHARE_PREFIX = "ozHR-";

export type HookrLpPoolSpec = {
  /** Stable, URL-safe key used in route ids (`hookr-lp-deposit-<key>`). */
  readonly key: string;
  /** The launched token's symbol as the pool is named in the catalog (`HOOKR/<symbol>`). */
  readonly symbol: string;
  readonly name: string;
  readonly token: Address;
  readonly decimals: number;
  /**
   * The pool's `HookedRangeVault`, baked ONLY after `DeployRobinhoodHookrLiquidity`
   * has broadcast and the address was read back independently. Undefined
   * means "no route for this pool yet".
   */
  readonly vault?: Address;
};

/**
 * The HOOKR-quoted launches with live liquidity when this slice was built
 * (2026-09-04, read off the PoolManager's `Initialize` history and per-pool
 * liquidity). A launch not listed here can still be reached by creating its
 * vault on the factory and naming it in `NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS`.
 */
export const HOOKR_LP_POOLS: readonly HookrLpPoolSpec[] = [
  { key: "canv5h", symbol: "CANV5H", name: "Canary Hookr Pair V5", token: getAddress("0xEB322DbCe33C7Fb44Dd58B591c06Ef2715AaF67C"), decimals: 18 },
  { key: "krn", symbol: "KRN", name: "Kraken Club", token: getAddress("0xBb371991468BD17d007a3Da6B400e6eD0CCd8807"), decimals: 18 },
  { key: "tcl", symbol: "TCL", name: "Tentacle", token: getAddress("0x8be7f9014653588dA3429d37e1CE52757D831F74"), decimals: 18 },
  { key: "hrfart", symbol: "HRFART", name: "HOOKR FART", token: getAddress("0xC450AF010fA4e46450BfBc78ea15A394A673F512"), decimals: 18 },
  { key: "hooking", symbol: "HOOKING", name: "HOOKING", token: getAddress("0x50e58c8D92a3e9bBEf55E8eF12743746c06255a9"), decimals: 18 },
];

export type HookrLpContracts = {
  readonly factory: Address;
  readonly depositAdapter: Address;
  readonly withdrawAdapter: Address;
};

function optionalAddress(value: string | undefined, fallback: Address = zeroAddress): Address {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) return fallback;
  const address = getAddress(trimmed);
  return address === zeroAddress ? fallback : address;
}

/**
 * The three contracts, read on every call so a test can configure them. The
 * fallbacks are the baked addresses once the deploy is verified — zero until
 * then, which keeps every Hookr LP route closed.
 */
export function hookrLpContracts(): HookrLpContracts {
  return {
    factory: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_FACTORY),
    depositAdapter: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER),
    withdrawAdapter: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_WITHDRAW_ADAPTER),
  };
}

export type HookrLpContractsState = "absent" | "partial" | "configured";

export function hookrLpContractsState(): HookrLpContractsState {
  const values = Object.values(hookrLpContracts());
  const configured = values.filter((address) => address !== zeroAddress).length;
  if (configured === 0) return "absent";
  return configured === values.length ? "configured" : "partial";
}

export function hookrLpConfigured(): boolean {
  return hookrLpContractsState() === "configured";
}

/**
 * Vault overrides for launches that post-date the last bake:
 * `NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS='{"krn":"0x…","tcl":"0x…"}'`, keyed by
 * pool key. Malformed JSON or a malformed address is ignored (fail closed to
 * "no vault"), never partially applied.
 */
function vaultOverrides(): Record<string, Address> {
  const raw = process.env.NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Address> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !/^[a-z0-9-]{1,32}$/.test(key)) return {};
      const address = optionalAddress(value);
      if (address === zeroAddress) return {};
      out[key] = address;
    }
    return out;
  } catch {
    return {};
  }
}

export type HookrLpPoolKey = {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
};

/** Sorted v4 pool key for a Hookr pool: HOOKR and the launched token, in address order. */
export function hookrLpPoolKey(token: Address): HookrLpPoolKey {
  const [currency0, currency1] =
    token.toLowerCase() < HOOKR_TOKEN.toLowerCase() ? [token, HOOKR_TOKEN] : [HOOKR_TOKEN, token];
  return {
    currency0,
    currency1,
    fee: HOOKR_LP_DYNAMIC_FEE,
    tickSpacing: HOOKR_LP_TICK_SPACING,
    hooks: HOOKR_HOOK,
  };
}

/** `keccak256(abi.encode(poolKey))`, exactly as v4-core derives it. */
export function hookrLpPoolId(token: Address): Hex {
  const key = hookrLpPoolKey(token);
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export type HookrLpPool = HookrLpPoolSpec & {
  /** Catalog `pool` param value. */
  readonly poolLabel: string;
  /** Catalog symbol of the vault share token. */
  readonly shareSymbol: string;
  readonly poolId: Hex;
  readonly poolKey: HookrLpPoolKey;
  /** The vault address in force (bake or env override), or null. */
  readonly vaultAddress: Address | null;
  readonly depositRouteId: string;
  readonly withdrawRouteId: string;
};

export function depositRouteIdFor(key: string): string {
  return `hookr-lp-deposit-${key}`;
}

export function withdrawRouteIdFor(key: string): string {
  return `hookr-lp-withdraw-${key}`;
}

/** Every listed pool with its derived identity, whether or not it is routable yet. */
export function hookrLpPools(): HookrLpPool[] {
  const overrides = vaultOverrides();
  return HOOKR_LP_POOLS.map((spec) => ({
    ...spec,
    poolLabel: `${HOOKR_LP_POOL_PREFIX}${spec.symbol}`,
    shareSymbol: `${HOOKR_LP_SHARE_PREFIX}${spec.symbol}`,
    poolId: hookrLpPoolId(spec.token),
    poolKey: hookrLpPoolKey(spec.token),
    vaultAddress: overrides[spec.key] ?? spec.vault ?? null,
    depositRouteId: depositRouteIdFor(spec.key),
    withdrawRouteId: withdrawRouteIdFor(spec.key),
  }));
}

/** The pool a route id belongs to, or null for any other id. */
export function hookrLpPoolForRoute(routeId: string): { pool: HookrLpPool; side: "deposit" | "withdraw" } | null {
  const match = /^hookr-lp-(deposit|withdraw)-([a-z0-9-]+)$/.exec(routeId);
  if (!match) return null;
  const pool = hookrLpPools().find((candidate) => candidate.key === match[2]);
  if (!pool) return null;
  return { pool, side: match[1] === "deposit" ? "deposit" : "withdraw" };
}

/** Catalog token entries for every pool's share token whose vault is known. */
export function hookrLpShareTokens(): Record<string, { symbol: string; address: Address; decimals: number }> {
  const out: Record<string, { symbol: string; address: Address; decimals: number }> = {};
  for (const pool of hookrLpPools()) {
    if (!pool.vaultAddress) continue;
    out[pool.shareSymbol] = { symbol: pool.shareSymbol, address: pool.vaultAddress, decimals: HOOKR_LP_SHARE_DECIMALS };
  }
  return out;
}

/** The `pool` option labels the add-liquidity block offers for Hookr pools. */
export function hookrLpPoolLabels(): string[] {
  return HOOKR_LP_POOLS.map((spec) => `${HOOKR_LP_POOL_PREFIX}${spec.symbol}`);
}

/** The share symbols the lp-position source block offers. */
export function hookrLpShareSymbols(): string[] {
  return HOOKR_LP_POOLS.map((spec) => `${HOOKR_LP_SHARE_PREFIX}${spec.symbol}`);
}
