import {
  defineChain,
  getAddress,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

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
} as const;

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

export function openZapProtocolConfigured(): boolean {
  return Object.values(OPENZAP_CONTRACTS).every((address) => address !== zeroAddress);
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

function optionalAddress(value: string | undefined, fallback: Address): Address {
  if (!value) return fallback;
  try {
    return getAddress(value);
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
