import { getAddress, isAddress, keccak256, encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";

/**
 * The Hookr slice: every Hookr-graduated pool OpenZaps can zap in to, out of, migrate between,
 * or trade on, across the three Hookr generations live on Robinhood Chain:
 *
 * - **V5 launchpad** — HOOKR-quoted pools sharing ONE hook (`HOOKR_HOOK_V5`).
 * - **Modular V2** — native-ETH-quoted markets on a shared root kernel, recorded by a coordinator.
 * - **Modular V3** — native-ETH-quoted markets, each with its OWN hook instance, recorded by the
 *   V3 coordinator. The coordinator's market record is the only authority on a market's hook.
 *
 * One `HookedRangeVault` per pool (from `HookedRangeVaultFactory`) wraps a full-range position
 * as an ERC-20 share; ONE deposit adapter and ONE withdraw adapter serve every vault; ONE market
 * swap adapter buys or sells the subject of any coordinator-recorded market. A native-quoted
 * pool is presented to the capsule with aeWETH ("WETH" in catalog vocabulary) as the quote face.
 *
 * FAIL CLOSED, twice over. The four contracts are an all-or-nothing set
 * (`hookrLpContractsState()`), and each pool additionally needs its vault address known — baked
 * into `HOOKR_LP_POOLS` after the deploy is verified, or supplied through the env overrides for a
 * launch that post-dates the last bake (`NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS` for vault addresses,
 * `NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS` for whole modular market rows). A pool with no known vault
 * resolves to no LP route; a modular market with no row resolves to no route at all.
 *
 * This module imports nothing from the rest of `src/lib` so `robinhood.ts`, `chains.ts`,
 * `routes.ts` and `blocks.ts` can all read it without a cycle.
 */

export const HOOKR_TOKEN: Address = getAddress("0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c");
export const AEWETH_TOKEN: Address = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
/** The V5 launchpad's shared hook — hookr.fun/docs, verified with the launchpad source. */
export const HOOKR_HOOK: Address = getAddress("0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC");
export const HOOKR_HOOK_V5 = HOOKR_HOOK;
/** Modular V2's shared root kernel. */
export const HOOKR_KERNEL_V2: Address = getAddress("0x26734cc3b9678966d881559963E5Db117f9228CC");
/** Hookr market coordinators, current release first: Modular V3, Modular V2 (post-canary), V2 canary. */
export const HOOKR_COORDINATORS: readonly Address[] = [
  getAddress("0x7b554efa746a76A2297489B2E8C2De6f19a3b59D"),
  getAddress("0x9B824615D3836BdC668fBe80bB5A50391765787f"),
  getAddress("0xa7DA0A9234197670d203Cba091a041e6Bcc297a5"),
];
export const HOOKR_LP_DYNAMIC_FEE = 0x800000;
export const HOOKR_LP_TICK_SPACING = 60;
export const HOOKR_LP_SHARE_DECIMALS = 18;
/** Catalog vocabulary: the `pool` param of the add-liquidity block, per quote. */
export const HOOKR_LP_POOL_PREFIX = "HOOKR/";
export const HOOKR_ETH_POOL_PREFIX = "ETH/";
/** Catalog vocabulary: the share-token symbol prefix (`ozHR-<SYMBOL>`). */
export const HOOKR_LP_SHARE_PREFIX = "ozHR-";
/** Catalog vocabulary: the `venue` a swap block names to route through a Hookr modular market. */
export const HOOKR_MARKET_VENUE = "Hookr";

export type HookrGeneration = "v5" | "v2" | "v3";
export type HookrQuote = "HOOKR" | "ETH";

export type HookrLpPoolSpec = {
  /** Stable, URL-safe key used in route ids (`hookr-lp-deposit-<key>`, `hookr-market-buy-<key>`). */
  readonly key: string;
  /** The launched token's symbol as the catalog names it. */
  readonly symbol: string;
  readonly name: string;
  readonly token: Address;
  readonly decimals: number;
  readonly generation: HookrGeneration;
  readonly quote: HookrQuote;
  /** The pool key's hook: the shared V5 hook, the V2 kernel, or a V3 per-market instance. */
  readonly hooks: Address;
  /**
   * The pool's `HookedRangeVault`, baked ONLY after a verified broadcast and independent
   * readback. Undefined means "no LP route for this pool yet".
   */
  readonly vault?: Address;
};

/**
 * The HOOKR-quoted V5 launches with live liquidity when this slice was built (2026-09-04, read
 * off the PoolManager's `Initialize` history and per-pool liquidity). Modular V2/V3 rows are
 * added here once Hookr opens public markets, or supplied through `NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS`.
 */
export const HOOKR_LP_POOLS: readonly HookrLpPoolSpec[] = [
  { key: "canv5h", symbol: "CANV5H", name: "Canary Hookr Pair V5", token: getAddress("0xEB322DbCe33C7Fb44Dd58B591c06Ef2715AaF67C"), decimals: 18, generation: "v5", quote: "HOOKR", hooks: HOOKR_HOOK_V5 },
  { key: "krn", symbol: "KRN", name: "Kraken Club", token: getAddress("0xBb371991468BD17d007a3Da6B400e6eD0CCd8807"), decimals: 18, generation: "v5", quote: "HOOKR", hooks: HOOKR_HOOK_V5 },
  { key: "tcl", symbol: "TCL", name: "Tentacle", token: getAddress("0x8be7f9014653588dA3429d37e1CE52757D831F74"), decimals: 18, generation: "v5", quote: "HOOKR", hooks: HOOKR_HOOK_V5 },
  { key: "hrfart", symbol: "HRFART", name: "HOOKR FART", token: getAddress("0xC450AF010fA4e46450BfBc78ea15A394A673F512"), decimals: 18, generation: "v5", quote: "HOOKR", hooks: HOOKR_HOOK_V5 },
  { key: "hooking", symbol: "HOOKING", name: "HOOKING", token: getAddress("0x50e58c8D92a3e9bBEf55E8eF12743746c06255a9"), decimals: 18, generation: "v5", quote: "HOOKR", hooks: HOOKR_HOOK_V5 },
];

export type HookrLpContracts = {
  readonly factory: Address;
  readonly depositAdapter: Address;
  readonly withdrawAdapter: Address;
  readonly marketSwapAdapter: Address;
};

function optionalAddress(value: string | undefined, fallback: Address = zeroAddress): Address {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) return fallback;
  const address = getAddress(trimmed);
  return address === zeroAddress ? fallback : address;
}

/**
 * The four contracts, read on every call so a test can configure them. The fallbacks are the
 * baked addresses once the deploy is verified — zero until then, which keeps every route closed.
 */
export function hookrLpContracts(): HookrLpContracts {
  return {
    factory: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_FACTORY),
    depositAdapter: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER),
    withdrawAdapter: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_WITHDRAW_ADAPTER),
    marketSwapAdapter: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_HOOKR_MARKET_SWAP_ADAPTER),
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

const KEY = /^[a-z0-9-]{1,32}$/;
const SYMBOL = /^[A-Za-z0-9]{1,12}$/;

/**
 * Vault overrides for launches that post-date the last bake:
 * `NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS='{"krn":"0x…"}'`, keyed by pool key. Malformed JSON or a
 * malformed address is ignored (fail closed to "no vault"), never partially applied.
 */
function vaultOverrides(): Record<string, Address> {
  const raw = process.env.NEXT_PUBLIC_OPENZAP_HOOKR_LP_VAULTS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Address> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !KEY.test(key)) return {};
      const address = optionalAddress(value);
      if (address === zeroAddress) return {};
      out[key] = address;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Whole modular market rows for launches that post-date the last bake:
 * `NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS='[{"key":"pepe","symbol":"PEPE","name":"Pepe","token":"0x…","hooks":"0x…","generation":"v3","quote":"ETH","vault":"0x…"}]'`.
 * Every field is validated; any defect discards the WHOLE list (fail closed), and a row whose
 * key collides with a baked row is ignored.
 */
function marketRowOverrides(): HookrLpPoolSpec[] {
  const raw = process.env.NEXT_PUBLIC_OPENZAP_HOOKR_MARKETS;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: HookrLpPoolSpec[] = [];
    const seen = new Set<string>(HOOKR_LP_POOLS.map((pool) => pool.key));
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const key = typeof row.key === "string" ? row.key : "";
      const symbol = typeof row.symbol === "string" ? row.symbol : "";
      const name = typeof row.name === "string" ? row.name : symbol;
      const generation = row.generation;
      const quote = row.quote;
      const token = optionalAddress(typeof row.token === "string" ? row.token : undefined);
      const hooks = optionalAddress(typeof row.hooks === "string" ? row.hooks : undefined);
      const vault = typeof row.vault === "string" ? optionalAddress(row.vault) : zeroAddress;
      const decimals = typeof row.decimals === "number" ? row.decimals : 18;
      if (
        !KEY.test(key) || !SYMBOL.test(symbol) || seen.has(key)
        || (generation !== "v2" && generation !== "v3" && generation !== "v5")
        || (quote !== "ETH" && quote !== "HOOKR")
        || token === zeroAddress || hooks === zeroAddress
        || !Number.isInteger(decimals) || decimals < 0 || decimals > 36
      ) {
        return [];
      }
      seen.add(key);
      rows.push({
        key,
        symbol,
        name,
        token,
        decimals,
        generation,
        quote,
        hooks,
        ...(vault !== zeroAddress ? { vault } : {}),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export type HookrLpPoolKey = {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
};

/** Sorted v4 pool key: the quote (native `0x0`, or HOOKR) and the launched token, in address order. */
export function hookrLpPoolKeyOf(token: Address, quote: HookrQuote, hooks: Address): HookrLpPoolKey {
  const quoteCurrency: Address = quote === "ETH" ? zeroAddress : HOOKR_TOKEN;
  const [currency0, currency1] =
    token.toLowerCase() < quoteCurrency.toLowerCase() ? [token, quoteCurrency] : [quoteCurrency, token];
  return { currency0, currency1, fee: HOOKR_LP_DYNAMIC_FEE, tickSpacing: HOOKR_LP_TICK_SPACING, hooks };
}

/** V5 lane helper kept for callers that only know the token: HOOKR-quoted, shared V5 hook. */
export function hookrLpPoolKey(token: Address): HookrLpPoolKey {
  return hookrLpPoolKeyOf(token, "HOOKR", HOOKR_HOOK_V5);
}

/** `keccak256(abi.encode(poolKey))`, exactly as v4-core derives it. */
export function hookrLpPoolIdOf(key: HookrLpPoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export function hookrLpPoolId(token: Address): Hex {
  return hookrLpPoolIdOf(hookrLpPoolKey(token));
}

export type HookrLpPool = HookrLpPoolSpec & {
  /** Catalog `pool` param value (`HOOKR/<SYM>` or `ETH/<SYM>`). */
  readonly poolLabel: string;
  /** Catalog symbol of the vault share token. */
  readonly shareSymbol: string;
  /** Catalog symbol of the quote as the capsule holds it: "HOOKR", or "WETH" (aeWETH) for native. */
  readonly quoteFaceSymbol: string;
  readonly quoteFaceAddress: Address;
  readonly poolId: Hex;
  readonly poolKey: HookrLpPoolKey;
  /** The vault address in force (bake or env override), or null. */
  readonly vaultAddress: Address | null;
  /** Whether the market swap adapter can trade this pool: only coordinator-recorded modular markets. */
  readonly modular: boolean;
  readonly depositRouteId: string;
  readonly withdrawRouteId: string;
  readonly marketBuyRouteId: string | null;
  readonly marketSellRouteId: string | null;
};

export function depositRouteIdFor(key: string): string {
  return `hookr-lp-deposit-${key}`;
}

export function withdrawRouteIdFor(key: string): string {
  return `hookr-lp-withdraw-${key}`;
}

export function marketBuyRouteIdFor(key: string): string {
  return `hookr-market-buy-${key}`;
}

export function marketSellRouteIdFor(key: string): string {
  return `hookr-market-sell-${key}`;
}

/** Every listed pool with its derived identity, whether or not it is routable yet. */
export function hookrLpPools(): HookrLpPool[] {
  const overrides = vaultOverrides();
  return [...HOOKR_LP_POOLS, ...marketRowOverrides()].map((spec) => {
    const poolKey = hookrLpPoolKeyOf(spec.token, spec.quote, spec.hooks);
    const modular = spec.generation !== "v5";
    return {
      ...spec,
      poolLabel: `${spec.quote === "ETH" ? HOOKR_ETH_POOL_PREFIX : HOOKR_LP_POOL_PREFIX}${spec.symbol}`,
      shareSymbol: `${HOOKR_LP_SHARE_PREFIX}${spec.symbol}`,
      quoteFaceSymbol: spec.quote === "ETH" ? "WETH" : "HOOKR",
      quoteFaceAddress: spec.quote === "ETH" ? AEWETH_TOKEN : HOOKR_TOKEN,
      poolId: hookrLpPoolIdOf(poolKey),
      poolKey,
      vaultAddress: overrides[spec.key] ?? spec.vault ?? null,
      modular,
      depositRouteId: depositRouteIdFor(spec.key),
      withdrawRouteId: withdrawRouteIdFor(spec.key),
      marketBuyRouteId: modular ? marketBuyRouteIdFor(spec.key) : null,
      marketSellRouteId: modular ? marketSellRouteIdFor(spec.key) : null,
    };
  });
}

/** The pool an LP route id belongs to, or null for any other id. */
export function hookrLpPoolForRoute(routeId: string): { pool: HookrLpPool; side: "deposit" | "withdraw" } | null {
  const match = /^hookr-lp-(deposit|withdraw)-([a-z0-9-]+)$/.exec(routeId);
  if (!match) return null;
  const pool = hookrLpPools().find((candidate) => candidate.key === match[2]);
  if (!pool) return null;
  return { pool, side: match[1] === "deposit" ? "deposit" : "withdraw" };
}

/** The modular market a market route id belongs to, or null for any other id. */
export function hookrMarketForRoute(routeId: string): { pool: HookrLpPool; side: "buy" | "sell" } | null {
  const match = /^hookr-market-(buy|sell)-([a-z0-9-]+)$/.exec(routeId);
  if (!match) return null;
  const pool = hookrLpPools().find((candidate) => candidate.key === match[2] && candidate.modular);
  if (!pool) return null;
  return { pool, side: match[1] === "buy" ? "buy" : "sell" };
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

/** Catalog token entries for every modular market's subject, so a swap can name it. */
export function hookrMarketSubjectTokens(): Record<string, { symbol: string; address: Address; decimals: number }> {
  const out: Record<string, { symbol: string; address: Address; decimals: number }> = {};
  for (const pool of hookrLpPools()) {
    if (!pool.modular) continue;
    out[pool.symbol] = { symbol: pool.symbol, address: pool.token, decimals: pool.decimals };
  }
  return out;
}

/** The `pool` option labels the add-liquidity block offers for Hookr pools. */
export function hookrLpPoolLabels(): string[] {
  return hookrLpPools().map((pool) => pool.poolLabel);
}

/** The share symbols the lp-position source block offers. */
export function hookrLpShareSymbols(): string[] {
  return hookrLpPools().map((pool) => pool.shareSymbol);
}

/** The subject symbols a swap block can buy through the Hookr venue. */
export function hookrMarketSubjectSymbols(): string[] {
  return hookrLpPools().filter((pool) => pool.modular).map((pool) => pool.symbol);
}
