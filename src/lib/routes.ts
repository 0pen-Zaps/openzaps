import { hookrLpPoolForRoute, hookrLpPoolIdOf, hookrMarketForRoute } from "@/lib/hookr-pools";
import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";

import {
  BOUNDED_SWAP_IDS,
  ROBINHOOD_ADAPTERS,
  adapterAddress,
  type AdapterSet,
  type AdapterSpec,
} from "@/lib/chains";
import {
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  hookrPoolKey,
  robinhoodPoolKey,
  tokenBySymbol,
  usdgPoolKey,
  zapVaultAbi,
  type TokenInfo,
} from "@/lib/robinhood";
import type { ZapDirection } from "@/lib/openzap";

/**
 * The single source of execution truth for the signing path.
 *
 * A `Route` is derived from a `chains.ts` `AdapterSpec` — never re-hardcoded —
 * and carries every per-route money fact the /app signer needs: the deployed
 * adapter, the two tokens with their REAL decimals, the tracked-asset pair, the
 * `Step.data` encoding this adapter demands, and where a quote comes from
 * (a v4 pool key, or an ERC-4626 vault that has no market price at all).
 *
 * The bounded aeWETH↔0xZAPS pair is the one route with a non-null `direction`;
 * every other route is identified by `id`/`adapter`, because `direction` (a
 * buy/sell bit) is ambiguous the moment a second pool shares an input token.
 */
export type RouteToken = TokenInfo;

export type V4PoolKey = {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
};

/**
 * Where the estimate for a route comes from. There is NO price for a vault
 * deposit: `previewDeposit`/`previewRedeem` price against the vault's live
 * supply/assets and can even return 0 (meaning "the call would revert"), which
 * is never a valid quote of zero output.
 */
export type RouteQuote =
  | { source: "v4"; poolKey: V4PoolKey; zeroForOne: boolean }
  /** A stitched multi-pool route: quote each hop in order, feeding outputs forward. */
  | { source: "v4-route"; hops: readonly { poolKey: V4PoolKey; zeroForOne: boolean }[] }
  | { source: "erc4626-deposit"; vault: Address }
  | { source: "erc4626-redeem"; vault: Address }
  /**
   * LP provide: half of `amountIn` is quoted through the vault's own pool, then
   * both legs go through `previewDeposit(amount0, amount1)`. `zeroForOne` is
   * the half-swap's direction from the route's tokenIn.
   */
  | { source: "range-deposit"; vault: Address; poolKey: V4PoolKey; zeroForOne: boolean }
  /**
   * LP withdraw: `previewRedeem(shares)` yields both currencies; the off-target
   * leg is quoted through the pool and added to the target.
   */
  | { source: "range-withdraw"; vault: Address; poolKey: V4PoolKey; assetOutIsCurrency0: boolean };

/**
 * What goes into `Step.data`, VERIFIED against each deployed adapter:
 * - "empty": `Step.data = 0x`. The original `RobinhoodV4SwapAdapter` REQUIRES
 *   it (reverts on any non-empty data) and both vault adapters take it.
 * - "min-amount-out": `Step.data = abi.encode(uint256 minAmountOut)`, the only
 *   shape the `RobinhoodV4PoolAdapter` (USDG pool) reads beyond empty.
 */
export type RouteDataKind =
  | "empty"
  | "min-amount-out"
  /**
   * `Step.data = abi.encode(address vault, uint256 minSharesOut)` for the
   * universal `HookedRangeDepositAdapter`: the vault is factory-verified by
   * the adapter, and the route pins which one.
   */
  | "hooked-lp-deposit"
  /**
   * `Step.data = abi.encode(address assetOut, uint256 minAssetsOut)` for the
   * universal `HookedRangeWithdrawAdapter`; the route pins the settlement asset.
   */
  | "hooked-lp-withdraw"
  /**
   * `Step.data = abi.encode(bytes32 poolId, uint256 minAmountOut)` for the
   * universal `HookrMarketSwapAdapter`; the route pins the market's pool id.
   */
  | "hookr-market";

export type Route = {
  readonly id: string;
  readonly kind: "swap" | "swap-route" | "vault-deposit" | "vault-redeem" | "lp-deposit" | "lp-withdraw";
  readonly adapter: Address;
  /** OpenZap forces `spender === adapter` at initialize; kept explicit. */
  readonly spender: Address;
  readonly tokenIn: RouteToken;
  readonly tokenOut: RouteToken;
  readonly trackedAssets: readonly [Address, Address];
  readonly data: RouteDataKind;
  readonly quote: RouteQuote;
  /** Vault routes: the RPC-holding caller must confirm totalSupply > 0. */
  readonly requiresSeededVault: boolean;
  /** Non-null only for the bounded aeWETH↔0xZAPS pair. */
  readonly direction: ZapDirection | null;
};

/**
 * Per-swap-adapter pool + data-encoding, keyed by spec id so nothing is guessed
 * from a token pair. A swap spec absent from this map cannot be resolved into a
 * Route (fail closed): offering a swap whose pool key we do not know would quote
 * and sign against the wrong pool.
 */
const SWAP_POOLS: Record<
  string,
  {
    poolKey: V4PoolKey;
    data: RouteDataKind;
    /**
     * True for a pool whose `currency0` is NATIVE ETH (`address(0)`). The
     * capsule settles ERC-20s only, so on such a route aeWETH stands in for
     * currency0: the route's direction and tracked pair are derived against
     * aeWETH while the QUOTE still uses the real native pool key verbatim.
     * The adapter owns the wrap boundary (see RobinhoodV4NativePoolAdapter).
     */
    nativeCurrency0?: boolean;
  }
> = {
  "robinhood-v4-weth-zaps": { poolKey: robinhoodPoolKey, data: "empty" },
  "robinhood-v4-zaps-weth": { poolKey: robinhoodPoolKey, data: "empty" },
  "robinhood-v4-weth-usdg": { poolKey: usdgPoolKey, data: "min-amount-out" },
  "robinhood-v4-usdg-weth": { poolKey: usdgPoolKey, data: "min-amount-out" },
  "robinhood-v4-weth-hookr": { poolKey: hookrPoolKey, data: "min-amount-out", nativeCurrency0: true },
  "robinhood-v4-hookr-weth": { poolKey: hookrPoolKey, data: "min-amount-out", nativeCurrency0: true },
};

/**
 * Per-route-adapter hop list, keyed by spec id, in execution order. Same
 * fail-closed rule as `SWAP_POOLS`: a `swap-route` spec absent here cannot be
 * resolved, because quoting a stitched route against guessed pools would quote
 * the wrong ones. Hop direction is derived by walking the token path, exactly
 * as the adapter itself does.
 */
const ROUTE_HOPS: Record<string, readonly V4PoolKey[]> = {
  "robinhood-v4-route-usdg-zaps": [usdgPoolKey, robinhoodPoolKey],
  "robinhood-v4-route-zaps-usdg": [robinhoodPoolKey, usdgPoolKey],
};

/**
 * Turn a registry spec into a fully-resolved onchain Route, or `null` when it
 * is not deployable as one: no configured adapter address, an unknown token
 * symbol, or a swap whose pool key is not registered above. Sync — it never
 * performs the vault seeding read; it only flags `requiresSeededVault`.
 */
export function resolveRoute(spec: AdapterSpec): Route | null {
  const rawAddress = adapterAddress(spec);
  if (rawAddress === null) return null;
  const adapter = getAddress(rawAddress);

  const tokenIn = tokenBySymbol(spec.tokenIn);
  const tokenOut = tokenBySymbol(spec.tokenOut);
  if (!tokenIn || !tokenOut) return null;

  const hookrMarket = hookrMarketForRoute(spec.id);
  if (hookrMarket) {
    // A Hookr modular market route: the pool key is the market's own (hooked,
    // dynamic-fee, per-market hook for V3), the quote face is aeWETH for a
    // native-quoted market, and the adapter takes the pool id as bounded step
    // data verified against the coordinator's record.
    const { pool, side } = hookrMarket;
    if (spec.kind !== "swap") return null;
    const quoteFace = pool.quoteFaceAddress;
    const expectedIn = side === "buy" ? quoteFace : pool.token;
    const expectedOut = side === "buy" ? pool.token : quoteFace;
    if (!isAddressEqual(tokenIn.address, expectedIn) || !isAddressEqual(tokenOut.address, expectedOut)) return null;
    const inCurrency = side === "buy"
      ? (pool.quote === "ETH" ? zeroAddress : quoteFace)
      : pool.token;
    const zeroForOne = isAddressEqual(inCurrency, pool.poolKey.currency0);
    const erc20Currency0 = pool.poolKey.currency0 === zeroAddress ? quoteFace : pool.poolKey.currency0;
    return {
      id: spec.id,
      kind: "swap",
      adapter,
      spender: adapter,
      tokenIn,
      tokenOut,
      trackedAssets: [erc20Currency0, pool.poolKey.currency1],
      data: "hookr-market",
      quote: { source: "v4", poolKey: pool.poolKey, zeroForOne },
      requiresSeededVault: false,
      direction: null,
    };
  }

  if (spec.kind === "swap") {
    const pool = SWAP_POOLS[spec.id];
    if (!pool) return null;
    // On a native-currency0 pool, aeWETH is the ERC-20 the capsule actually
    // holds on that side, so it is the address direction and tracking derive
    // against. Fail closed on a spec whose tokenIn is neither side of the pair:
    // guessing a direction would sign against the wrong side of the pool.
    const erc20Currency0 = pool.nativeCurrency0 ? ROBINHOOD_ASSETS.weth : pool.poolKey.currency0;
    if (
      !isAddressEqual(tokenIn.address, erc20Currency0)
      && !isAddressEqual(tokenIn.address, pool.poolKey.currency1)
    ) {
      return null;
    }
    // `zeroForOne` is read from the route's OWN pool key, never assumed: the
    // USDG pool orders (aeWETH, USDG), the 0xZAPS pool (aeWETH, 0xZAPS), and
    // the HOOKR pool (native ETH — aeWETH's stand-in — then HOOKR).
    const zeroForOne = isAddressEqual(tokenIn.address, erc20Currency0);
    // trackedAssets is the pool's [currency0, currency1] in a FIXED order for
    // both sides — NOT [tokenIn, tokenOut]. This is load-bearing for the bounded
    // route's byte-identity: the original policy commits [aeWETH, 0xZAPS] for
    // both buy and sell, which is exactly [currency0, currency1]. On a native
    // pool the tracked pair is the ERC-20 pair the capsule can measure.
    const trackedAssets: readonly [Address, Address] = [erc20Currency0, pool.poolKey.currency1];
    return {
      id: spec.id,
      kind: "swap",
      adapter,
      spender: adapter,
      tokenIn,
      tokenOut,
      trackedAssets,
      data: pool.data,
      quote: { source: "v4", poolKey: pool.poolKey, zeroForOne },
      requiresSeededVault: false,
      direction: spec.direction,
    };
  }

  if (spec.kind === "swap-route") {
    const hops = ROUTE_HOPS[spec.id];
    if (!hops) return null;
    // Walk the token path hop by hop, deriving each hop's direction from which
    // side of its pool the incoming token sits on — the adapter does the same.
    let hopIn = tokenIn.address;
    const quoteHops: { poolKey: V4PoolKey; zeroForOne: boolean }[] = [];
    for (const poolKey of hops) {
      const zeroForOne = isAddressEqual(hopIn, poolKey.currency0);
      if (!zeroForOne && !isAddressEqual(hopIn, poolKey.currency1)) return null; // broken hop table
      quoteHops.push({ poolKey, zeroForOne });
      hopIn = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    }
    if (!isAddressEqual(hopIn, tokenOut.address)) return null; // route must end on the spec's output
    return {
      id: spec.id,
      kind: "swap-route",
      adapter,
      spender: adapter,
      tokenIn,
      tokenOut,
      // The endpoints only: the intermediate token never rests in the capsule,
      // and settlement measures the final output.
      trackedAssets: [tokenIn.address, tokenOut.address],
      data: "min-amount-out",
      quote: { source: "v4-route", hops: quoteHops },
      requiresSeededVault: false,
      direction: null,
    };
  }

  const hookrLp = hookrLpPoolForRoute(spec.id);
  if (hookrLp) {
    // A Hookr pool route: the share token IS the pool's HookedRangeVault (known
    // only once baked or configured — tokenBySymbol already failed closed above
    // otherwise), the half-swap pool is the vault's own hooked pool, and the
    // adapter takes the vault / settlement asset as bounded step data.
    const { pool, side } = hookrLp;
    if (!pool.vaultAddress || spec.kind !== (side === "deposit" ? "lp-deposit" : "lp-withdraw")) return null;
    const vault = pool.vaultAddress;
    const quoteCurrency: Address = pool.quote === "ETH" ? zeroAddress : pool.quoteFaceAddress;
    if (side === "deposit") {
      if (!isAddressEqual(tokenOut.address, vault) || !isAddressEqual(tokenIn.address, pool.quoteFaceAddress)) return null;
      return {
        id: spec.id,
        kind: "lp-deposit",
        adapter,
        spender: adapter,
        tokenIn,
        tokenOut,
        trackedAssets: [tokenIn.address, vault],
        data: "hooked-lp-deposit",
        quote: {
          source: "range-deposit",
          vault,
          poolKey: pool.poolKey,
          // The half-swap spends the quote: native (currency0) on an ETH-quoted
          // market, HOOKR on a HOOKR-quoted one — aeWETH is only the face.
          zeroForOne: isAddressEqual(quoteCurrency, pool.poolKey.currency0),
        },
        // No seeding gate: the vault prices shares with a virtual offset, the
        // factory refuses a dead pool, and gating on totalSupply would mean no
        // one could ever be the first depositor.
        requiresSeededVault: false,
        direction: null,
      };
    }
    if (!isAddressEqual(tokenIn.address, vault) || !isAddressEqual(tokenOut.address, pool.quoteFaceAddress)) return null;
    return {
      id: spec.id,
      kind: "lp-withdraw",
      adapter,
      spender: adapter,
      tokenIn,
      tokenOut,
      trackedAssets: [vault, tokenOut.address],
      data: "hooked-lp-withdraw",
      quote: {
        source: "range-withdraw",
        vault,
        poolKey: pool.poolKey,
        assetOutIsCurrency0: isAddressEqual(quoteCurrency, pool.poolKey.currency0),
      },
      requiresSeededVault: false,
      direction: null,
    };
  }

  if (spec.kind === "lp-deposit" || spec.kind === "lp-withdraw") {
    // The ozRANGE share token IS the range vault, and the half-swap pool is the
    // vault's own aeWETH/USDG pool.
    const vault = spec.kind === "lp-deposit" ? tokenOut.address : tokenIn.address;
    const other = spec.kind === "lp-deposit" ? tokenIn : tokenOut;
    const trackedAssets: readonly [Address, Address] =
      spec.kind === "lp-deposit" ? [other.address, vault] : [vault, other.address];
    return {
      id: spec.id,
      kind: spec.kind,
      adapter,
      spender: adapter,
      tokenIn,
      tokenOut,
      trackedAssets,
      data: "min-amount-out",
      quote:
        spec.kind === "lp-deposit"
          ? {
              source: "range-deposit",
              vault,
              poolKey: usdgPoolKey,
              zeroForOne: isAddressEqual(tokenIn.address, usdgPoolKey.currency0),
            }
          : {
              source: "range-withdraw",
              vault,
              poolKey: usdgPoolKey,
              assetOutIsCurrency0: isAddressEqual(tokenOut.address, usdgPoolKey.currency0),
            },
      requiresSeededVault: true,
      direction: null,
    };
  }

  // Vault routes: the share token IS the vault. Both directions touch the same
  // two assets, tracked in a FIXED [asset, share] order so deposit and redeem
  // commit the identical pair — resolveRouteFromStep matches on it.
  const share = spec.kind === "vault-deposit" ? tokenOut.address : tokenIn.address; // ozUSDG (the vault)
  const asset = spec.kind === "vault-deposit" ? tokenIn.address : tokenOut.address; // USDG
  const trackedAssets: readonly [Address, Address] = [asset, share];
  return {
    id: spec.id,
    kind: spec.kind,
    adapter,
    spender: adapter,
    tokenIn,
    tokenOut,
    trackedAssets,
    data: "empty",
    quote:
      spec.kind === "vault-deposit"
        ? { source: "erc4626-deposit", vault: share }
        : { source: "erc4626-redeem", vault: share },
    requiresSeededVault: true,
    direction: null,
  };
}

/** The route with this registry id, resolved and deployed, or `null`. */
export function resolveRouteById(id: string, adapters: AdapterSet = ROBINHOOD_ADAPTERS): Route | null {
  const spec = adapters.find((candidate) => candidate.id === id);
  return spec ? resolveRoute(spec) : null;
}

/**
 * Whether a registry route has the exact quote path its adapter kind requires.
 *
 * The adapter registry alone is not enough to put a "deployable" badge in the
 * builder: a configured address with no matching pool/vault quote would send a
 * user to a signing screen that cannot derive a floor. This second gate is
 * intentionally exhaustive and fails closed for every unknown pairing.
 */
export function routeCatalogReady(id: string, adapters: AdapterSet = ROBINHOOD_ADAPTERS): boolean {
  const route = resolveRouteById(id, adapters);
  if (!route) return false;
  switch (route.kind) {
    case "swap":
      return route.quote.source === "v4";
    case "swap-route":
      return route.quote.source === "v4-route" && route.quote.hops.length > 0;
    case "vault-deposit":
      return route.quote.source === "erc4626-deposit"
        && isAddressEqual(route.quote.vault, route.tokenOut.address);
    case "vault-redeem":
      return route.quote.source === "erc4626-redeem"
        && isAddressEqual(route.quote.vault, route.tokenIn.address)
        && route.tokenIn.symbol === "ozUSDG"
        && route.tokenOut.symbol === "USDG";
    case "lp-deposit":
      return route.quote.source === "range-deposit";
    case "lp-withdraw":
      return route.quote.source === "range-withdraw";
  }
}

/**
 * Static create/handoff readiness. Structural catalog readiness is necessary
 * but not sufficient for a vault-backed route: without an RPC, this code cannot
 * prove totalSupply > 0 at one pinned block. Such routes stay reconstructible
 * as designs while builder badges and handoffs fail closed.
 */
export function routeStaticHandoffReady(
  id: string,
  adapters: AdapterSet = ROBINHOOD_ADAPTERS,
): boolean {
  const route = resolveRouteById(id, adapters);
  return Boolean(route && !route.requiresSeededVault && routeCatalogReady(id, adapters));
}

/**
 * Every deployable route on the chain, in registry order — WITHOUT the vault
 * seeding gate. This is the set an EXISTING capsule's implemented route is
 * matched against (verify/recover must keep working even if a vault later
 * empties), and the pre-seed input to the offered-route resolver.
 */
export function deployedRoutes(
  chainId: number = ROBINHOOD_CHAIN_ID,
  adapters: AdapterSet = ROBINHOOD_ADAPTERS,
): Route[] {
  const routes: Route[] = [];
  for (const spec of adapters) {
    if (spec.chainId !== chainId) continue;
    const route = resolveRoute(spec);
    if (route) routes.push(route);
  }
  return routes;
}

/**
 * The routes the UI may OFFER (create/handoff), applying the fail-closed vault
 * seeding gate: a vault route is dropped while `vault.totalSupply() === 0`,
 * because an unseeded ERC-4626 is grief-able. Swap routes need no read. The
 * bounded aeWETH↔0xZAPS buy/sell resolve first and byte-identically.
 */
export async function resolveOfferedRoutes(
  client: PublicClient,
  chainId: number = ROBINHOOD_CHAIN_ID,
  adapters: AdapterSet = ROBINHOOD_ADAPTERS,
): Promise<Route[]> {
  const candidates = deployedRoutes(chainId, adapters);
  const seeded = await Promise.all(
    candidates.map(async (route) => {
      if (!route.requiresSeededVault) return true;
      const vault = "vault" in route.quote ? route.quote.vault : null;
      if (!vault) return false;
      try {
        const supply = await client.readContract({ address: vault, abi: zapVaultAbi, functionName: "totalSupply" });
        return supply > 0n;
      } catch {
        // Fail closed: if the seeding read fails, do not offer the vault route.
        return false;
      }
    }),
  );
  return candidates.filter((_, index) => seeded[index]);
}

/**
 * The route an EXISTING onchain zap implements, resolved from its step. Keys on
 * the adapter ADDRESS first (one address == one pool/vault serving both sides),
 * then uses `tokenIn` to pick the side within that adapter's pair, then confirms
 * the tracked-asset pair and that `Step.data` fits the route's data kind.
 * Returns `null` — i.e. REJECT, outside the deployed/allowlisted set — for
 * anything unrecognized. Replaces the tokenIn-only `directionFromTokenIn`.
 */
export function resolveRouteFromStep(
  adapter: Address,
  tokenIn: Address,
  trackedAssets: readonly Address[],
  data: Hex,
  routes: Route[] = deployedRoutes(),
): Route | null {
  if (trackedAssets.length !== 2) return null;
  // One adapter address can serve MANY routes with the same tokenIn (the
  // universal Hookr LP adapters serve every pool), so every candidate is tried
  // and the tracked pair plus the pinned step data pick the one this step is.
  for (const route of routes) {
    if (!isAddressEqual(route.adapter, adapter) || !isAddressEqual(route.tokenIn.address, tokenIn)) continue;
    if (
      !isAddressEqual(trackedAssets[0], route.trackedAssets[0]) ||
      !isAddressEqual(trackedAssets[1], route.trackedAssets[1])
    ) {
      continue;
    }
    if (!stepDataFitsRoute(route, data)) continue;
    return route;
  }
  return null;
}

/**
 * Whether a step's `data` is within what the route's adapter accepts:
 * - "empty": exactly `0x`.
 * - "min-amount-out": `0x` (minAmountOut 0) or exactly 32 bytes (a uint256).
 * Anything else is rejected.
 */
export function stepDataFitsRoute(route: Route, data: Hex): boolean {
  const normalized = data.toLowerCase();
  if (route.data === "empty") return normalized === "0x";
  if (route.data === "hookr-market") {
    // Exactly two words, the first being the market's pool id.
    if (!/^0x[0-9a-f]{128}$/.test(normalized) || route.quote.source !== "v4") return false;
    return normalized.slice(2, 66) === hookrLpPoolIdOf(route.quote.poolKey).toLowerCase().slice(2);
  }
  if (route.data === "hooked-lp-deposit" || route.data === "hooked-lp-withdraw") {
    // Exactly two words, and the first must be the address the route pins: the
    // vault for a deposit, the settlement asset for a withdraw. A step naming
    // any other target is not this route, whatever adapter it calls.
    if (!/^0x[0-9a-f]{128}$/.test(normalized)) return false;
    const pinned =
      route.data === "hooked-lp-deposit" && route.quote.source === "range-deposit"
        ? route.quote.vault
        : route.tokenOut.address;
    return normalized.slice(2, 66) === pinned.toLowerCase().slice(2).padStart(64, "0");
  }
  // "min-amount-out": empty or exactly one 32-byte word.
  return normalized === "0x" || /^0x[0-9a-f]{64}$/.test(normalized);
}

export function isBoundedRouteId(id: string): boolean {
  return BOUNDED_SWAP_IDS.includes(id);
}
