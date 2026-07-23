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
import { resolveRouteById, resolveRouteFromStep, type Route } from "@/lib/routes";

export type ZapDirection = "buy" | "sell";

/** The bounded-pair route ids, one per side of the aeWETH/0xZAPS swap. */
export const BOUNDED_ROUTE_BY_DIRECTION: Record<ZapDirection, string> = {
  buy: "robinhood-v4-weth-zaps",
  sell: "robinhood-v4-zaps-weth",
};

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
  /** The deployed route this capsule implements — the primary route identity. */
  routeId: string;
  amountIn: string;
  createdAt: string;
  policyHash: Hex;
  createTx?: Hex;
}

export interface VerifiedZap {
  address: Address;
  /** The resolved route the onchain step actually implements. */
  route: Route;
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

/**
 * The exact bytes a route's adapter expects in `Step.data`.
 * - "empty": `0x`. Original swap (reverts on any data) and both vault adapters.
 * - "min-amount-out": `abi.encode(uint256 minOut)` for the USDG pool adapter.
 *   `minOut` defaults to 0 (no adapter-level floor); the binding slippage
 *   protection is the owner-signed `intent.minOut` computed fresh at execute
 *   time, so a stale non-zero value is never frozen into the immutable policy.
 */
export function encodeStepData(route: Route, minOut: bigint): Hex {
  if (route.data === "empty") return "0x";
  return encodeAbiParameters([{ type: "uint256" }], [minOut]);
}

/**
 * Build the one-step v1.1 policy for ANY deployed route. Generalises
 * `buildRobinhoodPolicy`: the adapter, spender, tokenIn, tracked-asset pair and
 * `Step.data` all come from the resolved route, and `amountIn` is already in the
 * route token's real decimals. For the bounded aeWETH↔0xZAPS route this emits a
 * byte-identical tuple to the pre-route code (invariant 1).
 */
export function buildRoutePolicy(
  owner: Address,
  route: Route,
  amountIn: bigint,
  minOut: bigint = 0n,
): RobinhoodPolicy {
  if (amountIn <= 0n || amountIn > MAX_ROUTER_AMOUNT) {
    throw new Error("The policy amount must be within the live router's uint128 range.");
  }

  return {
    owner,
    recipient: owner,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: [route.trackedAssets[0], route.trackedAssets[1]],
    steps: [
      {
        adapter: route.adapter,
        spender: route.spender,
        tokenIn: route.tokenIn.address,
        amountIn,
        data: encodeStepData(route, minOut),
      },
    ],
  };
}

/**
 * The bounded aeWETH↔0xZAPS policy, kept as a thin wrapper over `buildRoutePolicy`
 * so existing callers and the golden-hash tests are unchanged. Resolves the
 * bounded route for the direction and delegates; the emitted tuple is identical
 * to the pre-route implementation.
 */
export function buildRobinhoodPolicy(
  owner: Address,
  direction: ZapDirection,
  amountIn: bigint,
): RobinhoodPolicy {
  const route = resolveRouteById(BOUNDED_ROUTE_BY_DIRECTION[direction]);
  if (!route) {
    throw new Error("The bounded aeWETH/0xZAPS route is not configured.");
  }
  return buildRoutePolicy(owner, route, amountIn, 0n);
}

export function hashRobinhoodPolicy(policy: RobinhoodPolicy): Hex {
  return keccak256(encodeAbiParameters([policyParameter], [policy]));
}

/**
 * Parse a decimal amount at the token's REAL decimals. `decimals` defaults to 18
 * so the bounded aeWETH/0xZAPS callers and the golden tests are unchanged; every
 * route caller must pass `route.tokenIn.decimals` (USDG 6, ozUSDG 9) or a 6-dp
 * USDG amount would be scaled 10^12× too large. The uint128 ceiling is in raw
 * wei and stays valid at any decimals.
 */
export function parseRouterAmount(value: string, decimals: number = 18): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) {
    throw new Error("Enter a valid token amount.");
  }
  const fractional = normalized.split(".")[1] ?? "";
  if (fractional.length > decimals) {
    throw new Error(`Token amounts support at most ${decimals} decimal places.`);
  }
  const amount = parseUnits(normalized, decimals);
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
  if (step.amountIn <= 0n || step.amountIn > MAX_ROUTER_AMOUNT) {
    throw new Error("Zap step amount is outside the live router's uint128 range.");
  }

  // Resolve the route the capsule actually implements — adapter address first,
  // then the input token, then the tracked-asset pair and the Step.data shape.
  // Anything outside the deployed/allowlisted set returns null and is rejected
  // here (fail closed). Note: verification does NOT apply the vault seeding gate,
  // so an already-created vault zap stays inspectable and recoverable even if the
  // vault later empties.
  const route = resolveRouteFromStep(step.adapter, step.tokenIn, trackedAssets, step.data);
  if (!route) {
    throw new Error("Zap step is outside the deployed and allowlisted route set.");
  }
  if (!isAddressEqual(step.spender, route.adapter)) {
    throw new Error("Zap step spender does not equal its adapter.");
  }

  // Recompute the hash from the policy the clone EXPOSES and require it to equal
  // the hash it committed to. Combined with the route resolution above (which
  // pins the adapter, tracked assets and data shape), this proves the stored
  // policyHash matches a policy entirely within the resolved route. For the
  // bounded route this is identical to rebuilding the canonical policy.
  const rebuilt: RobinhoodPolicy = {
    owner,
    recipient,
    maxRelayerFeeCap,
    optimization,
    trackedAssets,
    steps: [
      {
        adapter: step.adapter,
        spender: step.spender,
        tokenIn: step.tokenIn,
        amountIn: step.amountIn,
        data: step.data,
      },
    ],
  };
  if (hashRobinhoodPolicy(rebuilt).toLowerCase() !== policyHash.toLowerCase()) {
    throw new Error("Zap policy hash does not match its onchain policy.");
  }

  return { address, route, amountIn: step.amountIn, policyHash };
}

export function directionFromTokenIn(tokenIn: Address): ZapDirection {
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.weth)) return "buy";
  if (isAddressEqual(tokenIn, ROBINHOOD_ASSETS.zaps)) return "sell";
  throw new Error("Zap input asset is outside the live aeWETH/0xZAPS route.");
}
