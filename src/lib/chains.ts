import { OPENZAP_CONTRACTS, ROBINHOOD_CHAIN_ID } from "@/lib/robinhood";
import type { ZapDirection } from "@/lib/openzap";

/**
 * The registry of adapters that are actually DEPLOYED.
 *
 * An adapter exists for the product only once two things are true: someone
 * deployed the contract, and governance allowlisted it in the AdapterRegistry.
 * Until both have happened, a step routed through it cannot execute — the
 * capsule reverts on an unallowlisted adapter — so offering it in the builder
 * would be promising a route that does not exist.
 *
 * This file is the single place that answers "does this adapter exist yet".
 * `deployable.ts` reads it and nothing else; it never hardcodes an address.
 * Every entry below is a *candidate*: a description of an adapter that either
 * is live now (`deployedAddress` baked in, because the app already signs
 * through it) or will be live when someone sets its env var. With no env
 * configured, the only deployed adapter is the bounded aeWETH ↔ 0xZAPS swap,
 * which is exactly the state of Robinhood Chain today.
 *
 * ---------------------------------------------------------------------------
 * SETTING ONE OF THESE ENV VARS CHANGES WHAT THE BUILDER OFFERS TO SIGN.
 *
 * Configuring an address here is the moment the product starts telling users a
 * step is deployable. So it must be the LAST step of a rollout, not the first:
 *   1. the adapter is deployed on chain 4663 and verified,
 *   2. governance has allowlisted it in the AdapterRegistry, and its tokens in
 *      the TokenAllowlist,
 *   3. the entry below still describes it exactly — same tokens, same welded
 *      protocol, same params. If the deployed adapter differs in any of those,
 *      edit the entry in the same change that sets the address, never after.
 * An entry that drifts from the contract it names is how a user ends up
 * signing a policy that does something other than what the block said.
 * ---------------------------------------------------------------------------
 */

/**
 * What a step does, in the vocabulary of the deployed adapter set.
 *
 * Deliberately coarse. The adapter's own weld — which pool, which vault —
 * lives in the entry, not in the kind, because allowlisting an adapter address
 * IS allowlisting one action against one protocol (`IAdapter.execute` takes a
 * fixed selector and no arbitrary calldata).
 */
export type AdapterKind = "swap" | "vault-deposit" | "vault-redeem";

/**
 * Env vars carrying deployed adapter addresses.
 *
 * A closed union rather than a free string so a typo in an entry is a type
 * error rather than an adapter that silently reads as "not deployed" forever.
 */
export type AdapterEnvVar =
  | "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER"
  | "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER"
  | "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER"
  | "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER";

export type AdapterSpec = {
  /** Stable id, used in policy readouts and rejection copy. */
  readonly id: string;
  readonly chainId: number;
  readonly kind: AdapterKind;
  /** How the adapter is named to a user. */
  readonly label: string;
  /**
   * Catalog block this adapter can execute, or `null` when no builder block
   * expresses this step yet. A `null` entry is still true — the adapter exists
   * and can be deployed — it just cannot be reached by drawing a chain.
   */
  readonly blockId: string | null;
  /**
   * Param values the adapter is welded to. A design that names anything else
   * is rejected BY NAME rather than mapped onto this adapter: an adapter's
   * protocol address is an immutable constructor arg, so "supply into Morpho"
   * can never be executed by a vault adapter welded to something else.
   */
  readonly weldedParams: Readonly<Record<string, string>>;
  /** Asset symbol, in the catalog's vocabulary, that the step pulls. */
  readonly tokenIn: string;
  /** Asset symbol the step hands back. */
  readonly tokenOut: string;
  /** For the bounded pair only: which side of it this entry is. */
  readonly direction: ZapDirection | null;
  readonly envVar: AdapterEnvVar;
  /**
   * Baked in ONLY for an adapter that is deployed and allowlisted right now.
   * `undefined` means NOT DEPLOYED, and nothing may be offered through it.
   */
  readonly deployedAddress?: string;
  /** What this adapter refuses to do, in one sentence, for the readout. */
  readonly refuses: string;
};

/** A registry entry whose address is configured — i.e. one that exists. */
export type DeployedAdapter = AdapterSpec & { readonly address: string };

/**
 * A set of candidate adapters.
 *
 * Every reader below takes one, defaulting to `ROBINHOOD_ADAPTERS`. The seam
 * exists so the mapper's multi-step reduction can be proven against a clearly
 * labelled fixture: no adapter chain in the real registry produces an asset
 * another real adapter consumes, so without this the only way to exercise a
 * two-step policy would be to put an entry in the shipped registry for
 * something nobody has deployed. That trade — a test seam here versus a
 * fictional row in the file that decides what the product claims — is not
 * close.
 */
export type AdapterSet = readonly AdapterSpec[];

/** The capsule's own ceiling: `OpenZap.execute()` walks at most 16 steps. */
export const MAX_POLICY_STEPS = 16;

/**
 * Robinhood Chain (4663) adapters.
 *
 * Base is deliberately absent. The builder's deploy handoff targets 4663 only,
 * and listing Base adapters here would put rows in a "what is deployed"
 * registry for a chain this product does not deploy to.
 */
export const ROBINHOOD_ADAPTERS: readonly AdapterSpec[] = [
  // ---- deployed today ------------------------------------------------------
  // One contract, both directions: RobinhoodV4PoolAdapter takes the PoolKey as
  // constructor immutables and picks `zeroForOne` from the token it is handed,
  // so the same allowlisted address executes either side of the one pool. Two
  // entries because the mapper matches on (tokenIn, tokenOut), not on a pool.
  {
    id: "robinhood-v4-weth-zaps",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "swap",
    label: "Uniswap v4 aeWETH → 0xZAPS",
    blockId: "swap",
    weldedParams: { venue: "Uniswap v4" },
    tokenIn: "WETH",
    tokenOut: "0xZAPS",
    direction: "buy",
    envVar: "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER",
    deployedAddress: OPENZAP_CONTRACTS.adapter,
    refuses:
      "Refuses any pool but the one welded into its constructor, any calldata beyond a bounded minimum-out, and any chain but 4663.",
  },
  {
    id: "robinhood-v4-zaps-weth",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "swap",
    label: "Uniswap v4 0xZAPS → aeWETH",
    blockId: "swap",
    weldedParams: { venue: "Uniswap v4" },
    tokenIn: "0xZAPS",
    tokenOut: "WETH",
    direction: "sell",
    envVar: "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER",
    deployedAddress: OPENZAP_CONTRACTS.adapter,
    refuses:
      "Refuses any pool but the one welded into its constructor, any calldata beyond a bounded minimum-out, and any chain but 4663.",
  },

  // The aeWETH/USDG pool `RobinhoodV4PoolAdapter` executes (fee 450,
  // tickSpacing 9, hookless) — the deepest hookless pool on that pair. Deployed
  // and allowlisted now, with the address baked below, so the builder offers a
  // USDG swap and the /app signing path can build a policy for it. Registering
  // the pair is also what makes a swap-then-deposit chain expressible at all,
  // since the vault takes USDG and no other swap adapter produces it.
  {
    id: "robinhood-v4-weth-usdg",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "swap",
    label: "Uniswap v4 aeWETH → USDG",
    blockId: "swap",
    weldedParams: { venue: "Uniswap v4" },
    tokenIn: "WETH",
    tokenOut: "USDG",
    // `direction` is the bounded aeWETH↔0xZAPS buy/sell bit and NOTHING else.
    // aeWETH is the input of both the 0xZAPS buy and this USDG buy, so a
    // non-null value here would let the app resolve this route as the 0xZAPS
    // one. Route identity keys on the adapter id, never on direction.
    direction: null,
    envVar: "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER",
    // Deployed and allowlisted on chain 4663 (RobinhoodV4PoolAdapter, aeWETH/USDG
    // pool fee 450 / tickSpacing 9 / hookless). Baked so the route is live without
    // Vercel env; the env var still overrides for a redeploy.
    deployedAddress: "0x714E48930d1d9a53149AA7B92cD88C9E172d1942",
    refuses:
      "Refuses any pool but the one welded into its constructor, any calldata beyond a bounded minimum-out, and any chain but 4663.",
  },
  {
    id: "robinhood-v4-usdg-weth",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "swap",
    label: "Uniswap v4 USDG → aeWETH",
    blockId: "swap",
    weldedParams: { venue: "Uniswap v4" },
    tokenIn: "USDG",
    tokenOut: "WETH",
    direction: null,
    envVar: "NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER",
    deployedAddress: "0x714E48930d1d9a53149AA7B92cD88C9E172d1942",
    refuses:
      "Refuses any pool but the one welded into its constructor, any calldata beyond a bounded minimum-out, and any chain but 4663.",
  },

  // ---- DEPLOYED, BUT FAIL-CLOSED ON SEEDING --------------------------------
  // `ZapVault` (ozUSDG) exists as a primitive, and these two adapters are the
  // only way a zap step can reach it — deposit (asset → shares) and redeem
  // (shares → asset). Both are deployed and allowlisted now, with addresses
  // baked below, so the registry reports them deployed. That is NOT the same as
  // offering them: the vault is unseeded (totalSupply 0), and an unseeded
  // ERC-4626 is inflation/donation grief-able, so the RPC-holding caller (/app)
  // must read `totalSupply() > 0` before offering, funding, or verifying a vault
  // route. `chains.ts`/`deployable.ts` cannot do that read (pure, sync, no RPC),
  // so the seed gate lives on /app; here the address is baked and the reachability
  // is what it is.
  //
  // The tokens come from `contracts/script/DeployRobinhoodExpansion.s.sol`,
  // which deploys the vault as `OpenZap USDG Vault` / `ozUSDG` against
  // `VAULT_ASSET`, defaulting to USDG. VAULT_ASSET is a deploy-time choice, so
  // if the vault ships against anything else these two rows are wrong the
  // moment an address is configured: edit them in the same change.
  //
  // The catalog now names both USDG (as a wallet-balance asset) and "ZapVault"
  // (as a supply venue), so a `[wallet-balance USDG] → [supply ZapVault]` chain
  // IS drawable and, with the address baked, deployable — which is exactly why
  // the /app seed gate is load-bearing rather than theoretical. Rejecting
  // "Supply into Morpho" is still the point: a design that names a protocol must
  // never be deployed as a different one, so the weld stays immutable.
  {
    id: "robinhood-zap-vault-deposit",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "vault-deposit",
    label: "OpenZap USDG Vault deposit",
    blockId: "supply",
    weldedParams: { market: "ZapVault" },
    tokenIn: "USDG",
    tokenOut: "ozUSDG",
    direction: null,
    envVar: "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER",
    // Deployed and allowlisted (ZapVaultDepositAdapter, ozUSDG vault). The
    // address being configured is NOT sufficient to offer this route: the vault
    // is unseeded (totalSupply 0) right now, and an unseeded ERC-4626 is
    // grief-able, so the RPC-holding caller (/app) must gate on totalSupply > 0
    // before offering, funding, or verifying it. Baked here so that gate — not a
    // missing address — is the only thing standing between the deposit and a user.
    deployedAddress: "0x1b289fD37Ff4497531a953aa922ab258F5e81164",
    refuses:
      "Refuses any vault or asset but the ones welded into its constructor, refuses to hold shares between calls, and refuses to report anything but the measured share delta.",
  },
  {
    // No catalog block turns a vault share back into tokens — nothing accepts
    // a receipt and emits a token — so this entry can never be selected by a
    // drawn chain, which is why `blockId` is null rather than a guess. It is
    // listed because the registry answers "what is deployed", not "what is
    // drawable": leaving it out would make a deployed redeem adapter invisible
    // to the next person reading this file.
    id: "robinhood-zap-vault-redeem",
    chainId: ROBINHOOD_CHAIN_ID,
    kind: "vault-redeem",
    label: "OpenZap USDG Vault redeem",
    blockId: null,
    weldedParams: {},
    tokenIn: "ozUSDG",
    tokenOut: "USDG",
    direction: null,
    envVar: "NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER",
    // Deployed and allowlisted (ZapVaultRedeemAdapter). `blockId` stays null: no
    // catalog block turns a share back into tokens, so a drawn chain can never
    // select this — it is offered on /app only, and only while the vault holds
    // shares to redeem (totalSupply > 0).
    deployedAddress: "0x16eD4f04657c7a965aef333F5Cf0c9d745e0c8cE",
    refuses:
      "Refuses any vault or asset but the ones welded into its constructor, and refuses to redeem to anyone but its caller.",
  },
];

/** The entries that make up the one route the app signs today. */
export const BOUNDED_SWAP_IDS: readonly string[] = ["robinhood-v4-weth-zaps", "robinhood-v4-zaps-weth"];

/**
 * Addresses read from the environment.
 *
 * Written as literal `process.env.NEXT_PUBLIC_*` member accesses on purpose:
 * Next.js replaces those statically when it builds the client bundle, and a
 * dynamic `process.env[name]` lookup would come back `undefined` in the
 * browser — an adapter that IS deployed would read as not deployed, and the
 * builder would reject designs it should accept. Read on every call rather
 * than cached at module load so a test can configure one and see it.
 */
function envAddresses(): Record<AdapterEnvVar, string | undefined> {
  return {
    NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER: process.env.NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER,
    NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER: process.env.NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER,
    NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER: process.env.NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER,
    NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER: process.env.NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER,
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Fail closed: anything that is not a plain 20-byte address, and the zero
 * address in particular, counts as NOT DEPLOYED. A malformed env var must
 * never widen what the builder offers — the worst outcome here is a design
 * being rejected while the adapter is in fact live, which is recoverable by
 * fixing the value. The other direction is not.
 */
function validAddress(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  return value.toLowerCase() !== ZERO_ADDRESS;
}

/** The configured address for a spec, or `null` when it is not deployed. */
export function adapterAddress(spec: AdapterSpec): string | null {
  // The baked-in address is the deployed truth for adapters the app already
  // signs through; the env var overrides it so a redeploy needs no code change.
  const configured = envAddresses()[spec.envVar] ?? spec.deployedAddress;
  return validAddress(configured) ? configured : null;
}

export function isAdapterDeployed(spec: AdapterSpec): boolean {
  return adapterAddress(spec) !== null;
}

/** Every adapter that exists right now, on the given chain. */
export function deployedAdapters(
  chainId: number = ROBINHOOD_CHAIN_ID,
  specs: AdapterSet = ROBINHOOD_ADAPTERS,
): DeployedAdapter[] {
  const live: DeployedAdapter[] = [];
  for (const spec of specs) {
    if (spec.chainId !== chainId) continue;
    const address = adapterAddress(spec);
    if (address === null) continue;
    live.push({ ...spec, address });
  }
  return live;
}

/** Registry entries for a block, deployed or not, in registry order. */
export function adapterSpecsForBlock(
  blockId: string,
  chainId: number = ROBINHOOD_CHAIN_ID,
  specs: AdapterSet = ROBINHOOD_ADAPTERS,
): AdapterSpec[] {
  return specs.filter((spec) => spec.chainId === chainId && spec.blockId === blockId);
}

export type AdapterQuery = {
  blockId: string;
  /** Asset the step will be handed. */
  tokenIn: string;
  /** Asset the step must hand back; omitted when the design does not name one. */
  tokenOut?: string;
  /** The design's params, checked against the entry's weld. */
  params?: Readonly<Record<string, unknown>>;
  chainId?: number;
};

/** Whether a spec answers a query — tokens and weld both have to match. */
function matches(spec: AdapterSpec, query: AdapterQuery): boolean {
  if (spec.blockId !== query.blockId) return false;
  if (spec.tokenIn !== query.tokenIn) return false;
  if (query.tokenOut !== undefined && spec.tokenOut !== query.tokenOut) return false;
  for (const [key, value] of Object.entries(spec.weldedParams)) {
    if (String(query.params?.[key] ?? "") !== value) return false;
  }
  return true;
}

/** Candidates that fit the query, whether or not they are deployed. */
export function matchingAdapterSpecs(query: AdapterQuery, specs: AdapterSet = ROBINHOOD_ADAPTERS): AdapterSpec[] {
  const chainId = query.chainId ?? ROBINHOOD_CHAIN_ID;
  return specs.filter((spec) => spec.chainId === chainId && matches(spec, query));
}

/**
 * The deployed adapter that can execute this step, or `null`.
 *
 * `null` is returned both when nothing fits and when the only thing that fits
 * is not deployed. Callers that need to tell those apart — and the rejection
 * copy does, because "no such adapter" and "not deployed yet" are different
 * facts — use `matchingAdapterSpecs` alongside this.
 */
export function findDeployedAdapter(query: AdapterQuery, specs: AdapterSet = ROBINHOOD_ADAPTERS): DeployedAdapter | null {
  for (const spec of matchingAdapterSpecs(query, specs)) {
    const address = adapterAddress(spec);
    if (address !== null) return { ...spec, address };
  }
  return null;
}

/**
 * Whether the deployed set is still nothing but the bounded aeWETH ↔ 0xZAPS
 * swap — i.e. whether today's one-route world still holds.
 *
 * The mapper refuses to emit a second step while this is true. Not because the
 * capsule cannot hold one (it holds 16) but because the single deployed
 * adapter is welded to a single pool: a second step could only be a second
 * pass through that same pool, and a policy that spends the asset it settles
 * in reverts on the capsule's balance-delta check. There is no honest second
 * step to offer until a second adapter exists.
 *
 * True as well when *nothing* is deployed — an empty set is not a wider one,
 * and every step is rejected for want of an adapter in that world anyway.
 */
export function onlyBoundedSwapIsDeployed(
  chainId: number = ROBINHOOD_CHAIN_ID,
  specs: AdapterSet = ROBINHOOD_ADAPTERS,
): boolean {
  // Reachability, not just deployment: an adapter with no catalog block cannot
  // widen what a user can draw, so it must not flip this off the bounded-route
  // message and into the generic multi-step one.
  return deployedAdapters(chainId, specs)
    .filter((adapter) => adapter.blockId !== null)
    .every((adapter) => BOUNDED_SWAP_IDS.includes(adapter.id));
}
