import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  openZapAbi,
  openZapFactoryAbi,
  policyComponents,
} from "@/lib/robinhood";

export type ZapDirection = "buy" | "sell";

export interface RobinhoodStep {
  adapter: Address;
  spender: Address;
  tokenIn: Address;
  amountIn: bigint;
  data: Hex;
}

export interface RobinhoodPolicy {
  owner: Address;
  recipient: Address;
  maxRelayerFeeCap: bigint;
  optimization: boolean;
  trackedAssets: readonly Address[];
  steps: readonly RobinhoodStep[];
}

export interface SavedZapRecord {
  address: Address;
  direction: ZapDirection;
  amountIn: string;
  createdAt: string;
  policyHash: Hex;
  createTx?: Hex;
}

export interface VerifiedZap {
  address: Address;
  direction: ZapDirection;
  amountIn: bigint;
  policyHash: Hex;
}

export const MAX_ROUTER_AMOUNT = (1n << 128n) - 1n;
export const MAX_EXECUTION_GAS = 3_000_000n;
export const MAX_EXECUTION_FEE_PER_GAS = 10_000_000_000n;

const policyParameter = {
  name: "policy",
  type: "tuple",
  components: policyComponents,
} as const;

export function assetsForDirection(direction: ZapDirection): {
  tokenIn: Address;
  tokenOut: Address;
  inputSymbol: "aeWETH" | "0xZAPS";
  outputSymbol: "aeWETH" | "0xZAPS";
  zeroForOne: boolean;
} {
  return direction === "buy"
    ? {
        tokenIn: ROBINHOOD_ASSETS.weth,
        tokenOut: ROBINHOOD_ASSETS.zaps,
        inputSymbol: "aeWETH",
        outputSymbol: "0xZAPS",
        zeroForOne: true,
      }
    : {
        tokenIn: ROBINHOOD_ASSETS.zaps,
        tokenOut: ROBINHOOD_ASSETS.weth,
        inputSymbol: "0xZAPS",
        outputSymbol: "aeWETH",
        zeroForOne: false,
      };
}

export function buildRobinhoodPolicy(
  owner: Address,
  direction: ZapDirection,
  amountIn: bigint,
): RobinhoodPolicy {
  if (amountIn <= 0n || amountIn > MAX_ROUTER_AMOUNT) {
    throw new Error("The policy amount must be within the live router's uint128 range.");
  }

  return {
    owner,
    recipient: owner,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps],
    steps: [
      {
        adapter: OPENZAP_CONTRACTS.adapter,
        spender: OPENZAP_CONTRACTS.adapter,
        tokenIn: assetsForDirection(direction).tokenIn,
        amountIn,
        data: "0x",
      },
    ],
  };
}

export function hashRobinhoodPolicy(policy: RobinhoodPolicy): Hex {
  return keccak256(encodeAbiParameters([policyParameter], [policy]));
}

export function parseRouterAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) {
    throw new Error("Enter a valid token amount.");
  }
  const fractional = normalized.split(".")[1] ?? "";
  if (fractional.length > 18) {
    throw new Error("Token amounts support at most 18 decimal places.");
  }
  const amount = parseUnits(normalized, 18);
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  if (amount > MAX_ROUTER_AMOUNT) {
    throw new Error("Amount exceeds the live router's uint128 limit.");
  }
  return amount;
}

export function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function randomNonce(): bigint {
  return BigInt(randomHex32());
}

export function expectedCloneRuntime(implementation: Address): Hex {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
}

export async function inspectOwnedZap(
  publicClient: PublicClient,
  zapAddress: Address,
  expectedOwner: Address,
): Promise<VerifiedZap> {
  const address = getAddress(zapAddress);
  const [runtime, implementation, configuredImplementationCode] = await Promise.all([
    publicClient.getBytecode({ address }),
    publicClient.readContract({
      address: OPENZAP_CONTRACTS.factory,
      abi: openZapFactoryAbi,
      functionName: "implementation",
    }),
    publicClient.getBytecode({ address: OPENZAP_CONTRACTS.implementation }),
  ]);

  if (!runtime || runtime.toLowerCase() !== expectedCloneRuntime(implementation).toLowerCase()) {
    throw new Error("Address is not a clone created from the current OpenZap implementation.");
  }
  if (!configuredImplementationCode || !isAddressEqual(implementation, OPENZAP_CONTRACTS.implementation)) {
    throw new Error("Factory implementation does not match this release.");
  }

  const [owner, recipient, maxRelayerFeeCap, optimization, trackedAssets, stepCount, step, policyHash] =
    await Promise.all([
      publicClient.readContract({ address, abi: openZapAbi, functionName: "owner" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "recipient" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "maxRelayerFeeCap" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "optimization" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "trackedAssets" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "stepCount" }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "step", args: [0n] }),
      publicClient.readContract({ address, abi: openZapAbi, functionName: "policyHash" }),
    ]);

  if (!isAddressEqual(owner, expectedOwner) || !isAddressEqual(recipient, expectedOwner)) {
    throw new Error("Zap owner and recipient must match the connected wallet.");
  }
  if (maxRelayerFeeCap !== 0n || !optimization || stepCount !== 1n) {
    throw new Error("Zap policy does not match the bounded v1.1 route.");
  }
  if (
    trackedAssets.length !== 2 ||
    !isAddressEqual(trackedAssets[0], ROBINHOOD_ASSETS.weth) ||
    !isAddressEqual(trackedAssets[1], ROBINHOOD_ASSETS.zaps)
  ) {
    throw new Error("Zap tracked assets do not match aeWETH and 0xZAPS.");
  }
  if (
    !isAddressEqual(step.adapter, OPENZAP_CONTRACTS.adapter) ||
    !isAddressEqual(step.spender, OPENZAP_CONTRACTS.adapter) ||
    step.data !== "0x" ||
    step.amountIn <= 0n ||
    step.amountIn > MAX_ROUTER_AMOUNT
  ) {
    throw new Error("Zap step is outside the live adapter constraints.");
  }

  const direction = directionFromTokenIn(step.tokenIn);
  const canonicalPolicy = buildRobinhoodPolicy(expectedOwner, direction, step.amountIn);
  if (hashRobinhoodPolicy(canonicalPolicy).toLowerCase() !== policyHash.toLowerCase()) {
    throw new Error("Zap policy hash does not match its onchain policy.");
  }

  return { address, direction, amountIn: step.amountIn, policyHash };
}

export function directionFromTokenIn(tokenIn: Address): ZapDirection {
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.weth)) return "buy";
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.zaps)) return "sell";
  throw new Error("Zap input asset is outside the live aeWETH/0xZAPS route.");
}
