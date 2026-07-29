import {
  defineChain,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/** Exact native fee paid when the current factory creates any new capsule. */
export const OPENZAP_CREATION_FEE = 10_000_000_000_000n; // 0.00001 ETH
/** The factory's fee conversion reverts below a freshly quoted 5% floor. */
export const OPENZAP_CREATION_FEE_SLIPPAGE_BPS = 500;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Robinhood Blockscout", url: ROBINHOOD_EXPLORER_URL },
  },
});

export const ROBINHOOD_ASSETS = {
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  zaps: getAddress("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"),
  // USDG has SIX decimals and ozUSDG has NINE. These are load-bearing money
  // facts: parsing/formatting a USDG amount at 18 decimals is off by 10^12.
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  // The ZapVault share token IS the vault contract; this address is both the
  // ozUSDG ERC-20 and the ERC-4626 vault previewDeposit/previewRedeem/totalSupply
  // are read from.
  ozusdg: getAddress("0xeAD10C998c59745a030FfAc9209b294C14C7D325"),
} as const;

export type TokenInfo = { readonly symbol: string; readonly address: Address; readonly decimals: number };
export type OptionalContractSetState = "absent" | "partial" | "configured";

/**
 * Optional future lineages are all-or-nothing. An all-zero set is deliberately
 * absent; a fully non-zero set may be used; any partial override is a release
 * error and must never silently shrink an authoritative factory scan.
 */
export function optionalContractSetState(
  contracts: Readonly<Record<string, Address>>,
): OptionalContractSetState {
  const values = Object.values(contracts);
  const configured = values.filter((address) => address !== zeroAddress).length;
  if (configured === 0) return "absent";
  return configured === values.length ? "configured" : "partial";
}

/**
 * The ZapRangeVault share token (ozRANGE) IS the vault contract — a full-range
 * Uniswap v4 LP position on the hookless aeWETH/USDG pool, wrapped as an
 * ERC-20. Deployed, seeded (seed shares burned to 0xdead) and allowlisted on
 * chain 4663; verified onchain 2026-07-23. The env var still overrides for a
 * redeploy, and a malformed value fails closed to "the token does not exist".
 */
export const RANGE_VAULT_ADDRESS: Address = optionalAddress(
  process.env.NEXT_PUBLIC_OPENZAP_RANGE_VAULT,
  "0x9FE852CE89c5920a87F8465C91B9e691f37BeD5B",
);

/**
 * Catalog symbol (the vocabulary `chains.ts` speaks) → the token's real onchain
 * identity. "WETH" is the catalog name for aeWETH; the UI symbol is "aeWETH".
 *
 * DECIMALS ARE PER TOKEN and every amount parse/format/quote/preview on the
 * signing path must use the route token's real decimals from here — never a
 * hardcoded 18. USDG is 6, ozUSDG is 9.
 */
export const ROBINHOOD_TOKENS: Record<string, TokenInfo> = {
  WETH: { symbol: "aeWETH", address: ROBINHOOD_ASSETS.weth, decimals: 18 },
  "0xZAPS": { symbol: "0xZAPS", address: ROBINHOOD_ASSETS.zaps, decimals: 18 },
  USDG: { symbol: "USDG", address: ROBINHOOD_ASSETS.usdg, decimals: 6 },
  ozUSDG: { symbol: "ozUSDG", address: ROBINHOOD_ASSETS.ozusdg, decimals: 9 },
  // ozRANGE exists only once its vault is deployed and configured; an unset or
  // malformed env var means the symbol is unknown and every route naming it
  // resolves to null (fail closed).
  ...(RANGE_VAULT_ADDRESS !== zeroAddress
    ? { ozRANGE: { symbol: "ozRANGE", address: RANGE_VAULT_ADDRESS, decimals: 18 } }
    : {}),
};

/** The token identity for a catalog symbol, or `null` when the symbol is unknown. */
export function tokenBySymbol(symbol: string): TokenInfo | null {
  return ROBINHOOD_TOKENS[symbol] ?? null;
}

export const ROBINHOOD_LIQUIDITY = {
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  universalRouter: getAddress("0x8876789976DeCBfcBbBE364623c63652db8c0904"),
  v4Quoter: getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94"),
  hook: getAddress("0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc"),
  poolId: "0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573" as Hex,
  dynamicFeeFlag: 0x800000,
  tickSpacing: 200,
  /**
   * What the Clanker hook actually charges a swap, in v4 fee units — hundredths
   * of a bip, so 1_000_000 is 100% and this is 1%.
   *
   * DISPLAY ONLY. The pool carries `dynamicFeeFlag`, so no static fee exists to
   * read off the PoolKey and quotes come from the quoter, never from here.
   * It lives in one place because it does not: the same number was written out
   * by hand on /token and /explore and both said 2%.
   *
   * Verified against the live hook (`clankerFee(poolId)` and `pairedFee(poolId)`
   * both return 10000). The hook owner can change it, so re-read it before
   * trusting this string:
   *   cast call 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc \
   *     "clankerFee(bytes32)(uint24)" <poolId> --rpc-url <ROBINHOOD_RPC_URL>
   */
  hookFeePips: 10_000,
} as const;

/** The hook fee as it is written in UI copy — "1%", never a hand-typed digit. */
export const HOOK_FEE_LABEL = `${ROBINHOOD_LIQUIDITY.hookFeePips / 10_000}%`;

/**
 * The aeWETH/USDG pool the `RobinhoodV4PoolAdapter` (0x714E…) is welded to — a
 * DIFFERENT PoolKey from the aeWETH/0xZAPS one above: static fee 450, tickSpacing
 * 9, hookless. Quoting a USDG swap against `robinhoodPoolKey` would silently
 * quote the wrong pool. Source of truth: `contracts/script/DeployRobinhoodExpansion.s.sol`.
 */
export const ROBINHOOD_USDG_POOL = {
  poolId: "0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2" as Hex,
  fee: 450,
  tickSpacing: 9,
} as const;

export const OPENZAP_CONTRACTS = {
  implementation: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_IMPLEMENTATION,
    "0x2a5EB455952d25b8060Ee933d2bADB022c7aE11A",
  ),
  factory: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_FACTORY,
    "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4",
  ),
  adapterRegistry: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_ADAPTER_REGISTRY,
    "0x9E56e444f490C00A6277326A47Cb462E12dF1f17",
  ),
  tokenAllowlist: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_TOKEN_ALLOWLIST,
    "0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B",
  ),
  adapter: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER,
    "0x04f62dA4b51a010eFa32aa81569169C47AEd602C",
  ),
} as const;

export const OPENZAP_V1_1_FACTORY_VERSION = "1.1.0";
export const OPENZAP_V1_2_FACTORY_VERSION = "1.2.0-candidate";

export function openZapProtocolConfigured(): boolean {
  return Object.values(OPENZAP_CONTRACTS).every((address) => address !== zeroAddress);
}

/**
 * The isolated v1.2 one-shot lineage. It adds the one-way policy halt and
 * transaction-scoped Permit2 owner pull without changing the existing v1.1
 * deployment or granting an executor standing authority.
 *
 * NOT YET DEPLOYED. The implementation, factory, exact-fee gateway, and its
 * constructor-bound creation pot are one release unit. All four addresses stay
 * zero until the final deployment is independently verified; any partial env
 * override is rejected by `openZapV1_2Configured` and the canonical lineage
 * registry.
 */
export const OPENZAP_V1_2_CONTRACTS = {
  implementation: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V1_2_IMPLEMENTATION, zeroAddress),
  factory: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V1_2_FACTORY, zeroAddress),
  creationGateway: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V1_2_CREATION_GATEWAY, zeroAddress),
  creationFeePot: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V1_2_CREATION_FEE_POT, zeroAddress),
} as const;

export function openZapV1_2Configured(): boolean {
  return optionalContractSetState(OPENZAP_V1_2_CONTRACTS) === "configured";
}

/**
 * The v3 execution stack (recurring + price-triggered capsules, executor economy). Deployed on
 * Robinhood Chain at block 17,601,632 — see docs/deployments.md. A SEPARATE lineage from the live
 * v1.1 factory above: v3 capsules sign under EIP-712 domain version "3" and pay the 1% executor
 * fee on the two standing-authorization paths. Same fail-closed pattern: a malformed env override
 * collapses to the zero address and `openZapV3Configured()` refuses the surface.
 */
export const OPENZAP_V3_CONTRACTS = {
  implementation: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_IMPLEMENTATION,
    "0x0309E72Ffd1c6855FF519d9E923AEFc0C52bFdb5",
  ),
  factory: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_FACTORY,
    "0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9",
  ),
  lotteryPot: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_LOTTERY_POT,
    "0xeB7a15CE1c969efBA43ecfc1A63960Ad0042CFe3",
  ),
  priceSourceRegistry: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_PRICE_SOURCE_REGISTRY,
    "0xd83a2dedb6185395A1Ac1d0abb9F98472feAd574",
  ),
  /** IPriceSource pinned to the live aeWETH/0xZAPS v4 pool — the trigger oracle. */
  poolPriceSource: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_POOL_PRICE_SOURCE,
    "0x60C310586541763D7f4dcc777F495f0627Bb098f",
  ),
} as const;

export function openZapV3Configured(): boolean {
  return Object.values(OPENZAP_V3_CONTRACTS).every((address) => address !== zeroAddress);
}

/**
 * The v3.1 relative-floor stack. Superset of v3: adds `executeRecurringRelative`, whose per-run
 * floor is computed from the ORIENTED price source's spot at execution (not an absolute number
 * frozen at signing), so a recurring series can't go stale. Deployed on Robinhood Chain
 * 2026-07-24 — see docs/deployments.md. Signs under EIP-712 domain version "3.1"; its own lottery
 * pot (setFactory is one-shot). The oriented source exposes currency0/currency1 so the capsule can
 * value either swap direction.
 */
export const OPENZAP_V3_1_CONTRACTS = {
  implementation: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_1_IMPLEMENTATION,
    "0x0fE5bC78b2bAc5f09E940C2aCcC0c3B785d91063",
  ),
  factory: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_1_FACTORY, "0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1"),
  lotteryPot: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_1_LOTTERY_POT, "0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1"),
  priceSourceRegistry: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_1_PRICE_SOURCE_REGISTRY,
    "0x76CB210F25D016078E10DbfCb19AFfBbB4892e33",
  ),
  /** IOrientedPriceSource pinned to the live aeWETH/0xZAPS pool — exposes currency0/currency1. */
  orientedPriceSource: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_V3_1_ORIENTED_PRICE_SOURCE,
    "0xB4f66bFa00D2496513a5fD43ff47912A3fe0Bb5F",
  ),
} as const;

export function openZapV3_1Configured(): boolean {
  return Object.values(OPENZAP_V3_1_CONTRACTS).every((address) => address !== zeroAddress);
}

/**
 * The v3.2 stacking stack. Superset of v3.1: adds `executeRecurringStack`, which diverts an
 * owner-signed `stackBps` slice of each run's post-fee output into 0xZAPS and stakes it to the
 * lottery pot as the owner's tickets. Signs under EIP-712 domain version "3.2"; like v3.1 it needs
 * its OWN lottery pot, because `ZapLotteryPot.setFactory` is one-shot.
 *
 * NOT YET DEPLOYED. Every address defaults to the zero address on purpose: `openZapV3_2Configured()`
 * therefore returns false, and the Automate surface must gate the stacking option behind it. Offering
 * a creation path into an undeployed lineage would fail-open — the user would pay a wallet
 * interaction for a transaction that cannot succeed. The stack-only creation gateway and its
 * constructor-bound creation pot are part of this one fail-closed set; the live v1 gateway/pot remain
 * separate because their active prize round cannot be rebound. Fill these in (or set the env vars)
 * only once `docs/deployments.md` records a verified v3.2 deployment and both pot bindings.
 */
export const OPENZAP_V3_2_CONTRACTS = {
  implementation: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_IMPLEMENTATION, zeroAddress),
  factory: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_FACTORY, zeroAddress),
  lotteryPot: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_LOTTERY_POT, zeroAddress),
  priceSourceRegistry: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_PRICE_SOURCE_REGISTRY, zeroAddress),
  /** IOrientedPriceSource for the main leg — same shape v3.1 uses. */
  orientedPriceSource: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_ORIENTED_PRICE_SOURCE, zeroAddress),
  /** Stack-only exact-fee gateway. It can call only the v3.2 factory. */
  creationGateway: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_CREATION_GATEWAY, zeroAddress),
  /** Dedicated no-drain creation prize pot, bound inside the gateway constructor. */
  creationFeePot: optionalAddress(process.env.NEXT_PUBLIC_OPENZAP_V3_2_CREATION_FEE_POT, zeroAddress),
} as const;

export function openZapV3_2Configured(): boolean {
  return optionalContractSetState(OPENZAP_V3_2_CONTRACTS) === "configured";
}

export type ConfiguredCapsuleLineage = {
  id: "v1.1" | "v1.2" | "v3" | "v3.1" | "v3.2";
  factory: Address;
  implementation: Address;
  lotteryPot: Address | null;
  /** Exact-fee creation infrastructure is not an execution or automation pot. */
  creationGateway?: Address | null;
  creationFeePot?: Address | null;
};

export type ConfiguredCapsuleLineageId = ConfiguredCapsuleLineage["id"];

/**
 * One canonical registry for every lineage an authoritative reader may scan.
 *
 * v1.1, v3, and v3.1 are mandatory production surfaces. v3.2 is optional while
 * undeployed, but all-or-nothing when enabled. Factories, implementations, and
 * execution pots are identity-bearing roles: silently deduping a duplicate
 * would make one lineage masquerade as another, so duplicates reject the whole
 * configuration before an RPC read can report a fabricated partial history.
 */
export function configuredCapsuleLineages(): readonly ConfiguredCapsuleLineage[] {
  const v1_2State = optionalContractSetState(OPENZAP_V1_2_CONTRACTS);
  const v3_2State = optionalContractSetState(OPENZAP_V3_2_CONTRACTS);
  if (
    !openZapProtocolConfigured()
    || !openZapV3Configured()
    || !openZapV3_1Configured()
    || v1_2State === "partial"
    || v3_2State === "partial"
  ) {
    throw new Error("Every mandatory OpenZap lineage must be configured and optional lineages must be all-or-nothing.");
  }

  const lineages: ConfiguredCapsuleLineage[] = [
    {
      id: "v1.1",
      factory: OPENZAP_CONTRACTS.factory,
      implementation: OPENZAP_CONTRACTS.implementation,
      lotteryPot: null,
    },
    ...(v1_2State === "configured"
      ? [{
          id: "v1.2" as const,
          factory: OPENZAP_V1_2_CONTRACTS.factory,
          implementation: OPENZAP_V1_2_CONTRACTS.implementation,
          lotteryPot: null,
          creationGateway: OPENZAP_V1_2_CONTRACTS.creationGateway,
          creationFeePot: OPENZAP_V1_2_CONTRACTS.creationFeePot,
        }]
      : []),
    {
      id: "v3",
      factory: OPENZAP_V3_CONTRACTS.factory,
      implementation: OPENZAP_V3_CONTRACTS.implementation,
      lotteryPot: OPENZAP_V3_CONTRACTS.lotteryPot,
    },
    {
      id: "v3.1",
      factory: OPENZAP_V3_1_CONTRACTS.factory,
      implementation: OPENZAP_V3_1_CONTRACTS.implementation,
      lotteryPot: OPENZAP_V3_1_CONTRACTS.lotteryPot,
    },
    ...(v3_2State === "configured"
      ? [{
          id: "v3.2" as const,
          factory: OPENZAP_V3_2_CONTRACTS.factory,
          implementation: OPENZAP_V3_2_CONTRACTS.implementation,
          lotteryPot: OPENZAP_V3_2_CONTRACTS.lotteryPot,
          creationGateway: OPENZAP_V3_2_CONTRACTS.creationGateway,
          creationFeePot: OPENZAP_V3_2_CONTRACTS.creationFeePot,
        }]
      : []),
  ];

  assertDistinctLineageRoles(lineages);
  return lineages;
}

export function configuredCapsuleFactories(): readonly Address[] {
  return configuredCapsuleLineages().map((lineage) => lineage.factory);
}

/** Resolve factory identity through the same all-or-nothing registry every reader scans. */
export function configuredCapsuleLineageForFactory(
  factory: Address,
): ConfiguredCapsuleLineage | null {
  return configuredCapsuleLineages().find((lineage) =>
    isAddressEqual(factory, lineage.factory)
  ) ?? null;
}

/**
 * The only canonical factories whose deployed clones expose `policyHalted`.
 * v3/v3.1 source may evolve, but their already deployed runtimes predate this
 * selector and therefore remain deliberately unsupported.
 */
export function configuredPolicyHaltLineages(): readonly (
  ConfiguredCapsuleLineage & { id: "v1.2" | "v3.2" }
)[] {
  return configuredCapsuleLineages().filter(
    (lineage): lineage is ConfiguredCapsuleLineage & { id: "v1.2" | "v3.2" } =>
      lineage.id === "v1.2" || lineage.id === "v3.2",
  );
}

export function configuredExecutionPots(): readonly { address: Address; label: string }[] {
  return configuredCapsuleLineages()
    .filter(
      (lineage): lineage is ConfiguredCapsuleLineage & { lotteryPot: Address } =>
        lineage.lotteryPot !== null,
    )
    .map((lineage) => ({ address: lineage.lotteryPot, label: lineage.id }));
}

/** Exported for a pure regression test; production callers use the registry above. */
export function assertDistinctLineageRoles(lineages: readonly ConfiguredCapsuleLineage[]): void {
  const seen = new Map<string, string>();
  for (const lineage of lineages) {
    const roles = [
      ["factory", lineage.factory],
      ["implementation", lineage.implementation],
      ...(lineage.lotteryPot === null ? [] : [["lottery pot", lineage.lotteryPot] as const]),
      ...(lineage.creationGateway == null
        ? []
        : [["creation gateway", lineage.creationGateway] as const]),
      ...(lineage.creationFeePot == null
        ? []
        : [["creation fee pot", lineage.creationFeePot] as const]),
    ] as const;
    for (const [role, address] of roles) {
      if (address === zeroAddress) {
        throw new Error(`${lineage.id} ${role} is not configured.`);
      }
      const key = address.toLowerCase();
      const prior = seen.get(key);
      if (prior) {
        throw new Error(`${lineage.id} ${role} duplicates ${prior}.`);
      }
      seen.set(key, `${lineage.id} ${role}`);
    }
  }
}

/**
 * Universal app-creation fee gateway. The immutable gateway calls the already-live v1.1/v3/v3.1
 * factories, then converts the exact native creation fee through the pinned aeWETH -> 0xZAPS route.
 * Deployed and independently read back on Robinhood Chain at blocks 19,539,599–19,539,642. Env
 * overrides remain available for a future redeploy; malformed overrides still fail closed.
 */
export const OPENZAP_CREATION_FEE_CONTRACTS = {
  gateway: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_CREATION_GATEWAY,
    "0x02A17a94A0e2B470e931E98079Bf563c94281B2b",
  ),
  pot: optionalAddress(
    process.env.NEXT_PUBLIC_OPENZAP_CREATION_FEE_POT,
    "0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863",
  ),
} as const;

export function openZapCreationFeeConfigured(): boolean {
  return Object.values(OPENZAP_CREATION_FEE_CONTRACTS).every((address) => address !== zeroAddress);
}

export function explorerAddress(address: Address): string {
  return `${ROBINHOOD_EXPLORER_URL}/address/${address}`;
}

export function explorerTransaction(hash: Hex): string {
  return `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`;
}

export function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined" || !("ethereum" in window)) return null;
  return window.ethereum as EIP1193Provider;
}

export async function ensureRobinhoodChain(provider: EIP1193Provider): Promise<void> {
  const expected = `0x${ROBINHOOD_CHAIN_ID.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === expected) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expected }],
    });
  } catch (switchError) {
    if (walletErrorCode(switchError) !== 4902) throw switchError;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: expected,
          chainName: robinhoodChain.name,
          nativeCurrency: robinhoodChain.nativeCurrency,
          rpcUrls: [ROBINHOOD_RPC_URL],
          blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expected }],
    });
  }
}

export async function watchZapsAsset(provider: EIP1193Provider, image?: string): Promise<boolean> {
  const result = await provider.request({
    method: "wallet_watchAsset",
    params: {
      type: "ERC20",
      options: {
        address: ROBINHOOD_ASSETS.zaps,
        symbol: "0xZAPS",
        decimals: 18,
        ...(image ? { image } : {}),
      },
    },
  });
  return result === true;
}

export const robinhoodPoolKey = {
  currency0: ROBINHOOD_ASSETS.weth,
  currency1: ROBINHOOD_ASSETS.zaps,
  fee: ROBINHOOD_LIQUIDITY.dynamicFeeFlag,
  tickSpacing: ROBINHOOD_LIQUIDITY.tickSpacing,
  hooks: ROBINHOOD_LIQUIDITY.hook,
} as const;

/**
 * The PoolKey for the aeWETH/USDG pool. `currency0 < currency1` by address, so
 * aeWETH (0x0Bd7…) is currency0 and USDG (0x5fc5…) is currency1; a buy
 * (aeWETH→USDG) is therefore `zeroForOne = true`. Hookless, so `hooks` is the
 * zero address.
 */
export const usdgPoolKey = {
  currency0: ROBINHOOD_ASSETS.weth,
  currency1: ROBINHOOD_ASSETS.usdg,
  fee: ROBINHOOD_USDG_POOL.fee,
  tickSpacing: ROBINHOOD_USDG_POOL.tickSpacing,
  hooks: zeroAddress,
} as const;

/**
 * The read surface of `ZapVault` the signing path needs. A vault deposit has NO
 * market price: `previewDeposit(assets)→shares` and `previewRedeem(shares)→assets`
 * are the only quote sources, and `totalSupply()` is the fail-closed seeding
 * gate — an unseeded vault (totalSupply 0) is grief-able and must never be offered.
 */
export const zapVaultAbi = [
  {
    type: "function",
    name: "previewDeposit",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewRedeem",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "asset",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/**
 * The read surface of `ZapRangeVault` the signing path needs. Like the ERC-4626
 * vault, an LP deposit has no market price: `previewDeposit(amount0, amount1)`
 * and `previewRedeem(shares)` price against the live pool + position state, and
 * `totalSupply()` is the same fail-closed seeding gate.
 */
export const rangeVaultAbi = [
  {
    type: "function",
    name: "previewDeposit",
    inputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
    outputs: [
      { name: "shares", type: "uint256" },
      { name: "liquidityAdded", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewRedeem",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "positionLiquidity",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export const wethAbi = [
  ...erc20Abi,
  { type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable" },
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const stepComponents = [
  { name: "adapter", type: "address" },
  { name: "tokenIn", type: "address" },
  { name: "spender", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

export const policyComponents = [
  { name: "owner", type: "address" },
  { name: "recipient", type: "address" },
  { name: "maxRelayerFeeCap", type: "uint256" },
  { name: "optimization", type: "bool" },
  { name: "trackedAssets", type: "address[]" },
  { name: "steps", type: "tuple[]", components: stepComponents },
] as const;

const intentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "recipient", type: "address" },
  { name: "relayer", type: "address" },
  { name: "maxRelayerFee", type: "uint256" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "minOut", type: "uint256" },
] as const;

const permit2TokenPermissionsComponents = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

const permit2TransferPermitComponents = [
  {
    name: "permitted",
    type: "tuple",
    components: permit2TokenPermissionsComponents,
  },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export const openZapFactoryAbi = [
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implCodeHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "createZap",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "zap", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "predict",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ZapCreated",
    inputs: [
      { name: "zap", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: false },
      { name: "implCodeHash", type: "bytes32", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const;

/**
 * v1.2 keeps the v1 factory write surface, and exposes the two immutable shared
 * policy registries that provenance verification must pin before a wallet uses
 * the new owner-pull path.
 */
export const openZapV1_2FactoryAbi = [
  ...openZapFactoryAbi,
  {
    type: "function",
    name: "adapters",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokens",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const openZapCreationGatewayAbi = [
  {
    type: "function",
    name: "createZap",
    inputs: [
      { name: "lineage", type: "uint8" },
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
      { name: "minZapsOut", type: "uint256" },
    ],
    outputs: [{ name: "zap", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "CREATION_FEE",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_POT",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "AEWETH",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ZAPS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_ADAPTER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lineageFactory",
    inputs: [{ name: "lineage", type: "uint8" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

export const openZapStackCreationGatewayAbi = [
  {
    type: "function",
    name: "createZap",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
      { name: "minZapsOut", type: "uint256" },
    ],
    outputs: [{ name: "zap", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "CREATION_FEE",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_POT",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "AEWETH",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ZAPS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_ADAPTER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "STACK_FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

/** Exact public surface of the constructor-bound v1.2 creation gateway. */
export const openZapV1_2CreationGatewayAbi = [
  {
    type: "function",
    name: "createZap",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
      { name: "minZapsOut", type: "uint256" },
    ],
    outputs: [{ name: "zap", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "predict",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "V1_2_FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "AEWETH",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ZAPS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_ADAPTER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_FEE",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CREATION_POT",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "V1_2CreationFeeConverted",
    inputs: [
      { name: "zap", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "factory", type: "address", indexed: true },
      { name: "nativeAmount", type: "uint256", indexed: false },
      { name: "zapsOut", type: "uint256", indexed: false },
    ],
  },
] as const;

export const zapCreationFeePotAbi = [
  {
    type: "function",
    name: "gateway",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ZAPS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "accountedZaps",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const openZapAbi = [
  {
    type: "function",
    name: "recipient",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maxRelayerFeeCap",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "optimization",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "trackedAssets",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "stepCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "step",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: stepComponents }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "policyHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonceUsed",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "intent", type: "tuple", components: intentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "emergencyExit",
    inputs: [{ name: "assets", type: "address[]" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "invalidateNonce",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * v1.2 capsule read/write surface. It deliberately extends the existing
 * one-shot ABI instead of changing v1.1 callers.
 */
export const openZapV1_2Abi = [
  ...openZapAbi,
  {
    type: "function",
    name: "FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ADAPTERS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "TOKENS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "PERMIT2",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "PERMIT2_MAX_DEADLINE_WINDOW",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "policyHalted",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeWithPermit2",
    inputs: [
      { name: "intent", type: "tuple", components: intentComponents },
      { name: "permit", type: "tuple", components: permit2TransferPermitComponents },
      { name: "intentSig", type: "bytes" },
      { name: "permitSig", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "haltPolicy",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "PolicyHalted",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: true },
    ],
  },
] as const;

/**
 * Shared one-way stop surface for canonical v1.2 and v3.2 clones. Readers must
 * still prove the clone's factory lineage before using this ABI.
 */
export const openZapPolicyHaltAbi = [
  {
    type: "function",
    name: "FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "policyHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "policyHalted",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "haltPolicy",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "PolicyHalted",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: true },
    ],
  },
] as const;

/**
 * Canonical Permit2 unordered-nonce surface used for owner-pull readback and
 * owner cancellation. The capsule, not the relay submitter, is the signed
 * spender for `executeWithPermit2`.
 */
export const permit2NonceBitmapAbi = [
  {
    type: "function",
    name: "nonceBitmap",
    inputs: [
      { name: "owner", type: "address" },
      { name: "wordPos", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "invalidateUnorderedNonces",
    inputs: [
      { name: "wordPos", type: "uint256" },
      { name: "mask", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

/** Mirrors `RecurringIntent` in contracts/src/v3 — field order is signature-bearing. */
const recurringIntentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "seriesId", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "interval", type: "uint64" },
  { name: "maxRuns", type: "uint32" },
  { name: "recipient", type: "address" },
  { name: "executor", type: "address" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "minOutPerRun", type: "uint256" },
] as const;

/** Mirrors `TriggerIntent` in contracts/src/v3. */
const triggerIntentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "priceSource", type: "address" },
  { name: "baselinePriceX96", type: "uint256" },
  { name: "thresholdBps", type: "uint32" },
  { name: "above", type: "bool" },
  { name: "recipient", type: "address" },
  { name: "executor", type: "address" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "minOut", type: "uint256" },
] as const;

export const allowlistReadAbi = [
  {
    type: "function",
    name: "isAllowed",
    inputs: [{ name: "candidate", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export const openZapFactoryV3Abi = [
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implCodeHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "VERSION",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "adapters",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokens",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "priceSources",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lotteryPot",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "createZap",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "zap", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "predict",
    inputs: [
      { name: "p", type: "tuple", components: policyComponents },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ZapCreated",
    inputs: [
      { name: "zap", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: false },
      { name: "implCodeHash", type: "bytes32", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const openZapV3Abi = [
  {
    type: "function",
    name: "FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ADAPTERS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "TOKENS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "PRICE_SOURCES",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "LOTTERY_POT",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recipient",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "policyHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "stepCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "trackedAssets",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonceUsed",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "series",
    inputs: [{ name: "seriesId", type: "uint256" }],
    outputs: [
      { name: "runs", type: "uint32" },
      { name: "lastRun", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeRecurring",
    inputs: [
      { name: "intent", type: "tuple", components: recurringIntentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeTrigger",
    inputs: [
      { name: "intent", type: "tuple", components: triggerIntentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "invalidateNonce",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "emergencyExit",
    inputs: [{ name: "assets", type: "address[]" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** Mirrors `RecurringRelativeIntent` in contracts/src/v3_1 — order is signature-bearing. Same as
 *  RecurringIntent but the trailing `minOutPerRun` is replaced by `priceSource` + `maxSlippageBps`. */
export const recurringRelativeIntentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "seriesId", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "interval", type: "uint64" },
  { name: "maxRuns", type: "uint32" },
  { name: "recipient", type: "address" },
  { name: "executor", type: "address" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "priceSource", type: "address" },
  { name: "maxSlippageBps", type: "uint32" },
] as const;

/** v3.1 capsule ABI: the v3 surface plus `executeRecurringRelative`. The factory ABI is identical
 *  to v3's (`openZapFactoryV3Abi`) — same Policy tuple, createZap/predict. */
export const openZapV3_1Abi = [
  ...openZapV3Abi,
  {
    type: "function",
    name: "executeRecurringRelative",
    inputs: [
      { name: "intent", type: "tuple", components: recurringRelativeIntentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** v3.2 provenance surface in addition to the inherited v3/v3.1 reads. */
export const openZapV3_2ProvenanceAbi = [
  ...openZapV3Abi,
  {
    type: "function",
    name: "ZAPS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ZAPS_ADAPTER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/** The oriented price source exposes the pool's currencies so a UI/executor can value either side. */
export const orientedPriceSourceAbi = [
  { type: "function", name: "priceX96", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "currency0", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "currency1", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
] as const;

export const lotteryPotAbi = [
  {
    type: "function",
    name: "currentRound",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "roundPrize",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tickets",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalTickets",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const priceSourceAbi = [
  {
    type: "function",
    name: "priceX96",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// Checksum-normalize whichever address is in effect — the env override OR the hardcoded fallback.
// Running the fallback through getAddress too means a bad literal fails CLOSED (→ zeroAddress, which
// trips openZapV3*Configured and disables the flow loudly) instead of silently reaching viem, whose
// readContract/typed-data encoding reject a mis-checksummed address at call time. The `Address` cast
// on a literal is compile-time only; it never validates the checksum.
function optionalAddress(value: string | undefined, fallback: Address): Address {
  try {
    // `|| fallback` (not `??`) so a declared-but-empty env override ("") is treated as unset, matching
    // the prior behaviour — Next.js inlines an empty var as "", which getAddress would otherwise reject.
    return getAddress(value || fallback);
  } catch {
    return zeroAddress;
  }
}

function walletErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const direct = "code" in error ? Number(error.code) : Number.NaN;
  if (Number.isFinite(direct)) return direct;
  if ("cause" in error) return walletErrorCode(error.cause);
  return null;
}
