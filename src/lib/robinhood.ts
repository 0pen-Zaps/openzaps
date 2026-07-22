import {
  defineChain,
  getAddress,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
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
} as const;

export const ROBINHOOD_LIQUIDITY = {
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  universalRouter: getAddress("0x8876789976DeCBfcBbBE364623c63652db8c0904"),
  v4Quoter: getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94"),
  hook: getAddress("0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc"),
  poolId: "0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573" as Hex,
  dynamicFeeFlag: 0x800000,
  tickSpacing: 200,
} as const;

export const OPENZAP_CONTRACTS = {
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

export const robinhoodPoolKey = {
  currency0: ROBINHOOD_ASSETS.weth,
  currency1: ROBINHOOD_ASSETS.zaps,
  fee: ROBINHOOD_LIQUIDITY.dynamicFeeFlag,
  tickSpacing: ROBINHOOD_LIQUIDITY.tickSpacing,
  hooks: ROBINHOOD_LIQUIDITY.hook,
} as const;

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

const stepComponents = [
  { name: "adapter", type: "address" },
  { name: "spender", type: "address" },
  { name: "tokenIn", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

const policyComponents = [
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

function optionalAddress(value: string | undefined, fallback: Address): Address {
  if (!value) return fallback;
  try {
    return getAddress(value);
  } catch {
    return zeroAddress;
  }
}
