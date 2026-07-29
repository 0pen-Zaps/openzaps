import type { Address, Hex, TypedDataDomain } from "viem";

export interface OpenZapPolicyStep {
  adapter: Address;
  tokenIn: Address;
  spender: Address;
  amountIn: bigint;
  data: Hex;
}

export interface OpenZapPolicy {
  owner: Address;
  recipient: Address;
  maxRelayerFeeCap: bigint;
  optimization: boolean;
  trackedAssets: Address[];
  steps: OpenZapPolicyStep[];
}

export interface OpenZapPolicyInput {
  owner: Address | string;
  recipient?: Address | string;
  adapter: Address | string;
  spender?: Address | string;
  tokenIn: Address | string;
  amountIn: bigint | number | string;
  data?: Hex;
  trackedAssets: readonly (Address | string)[];
  maxRelayerFeeCap?: bigint | number | string;
  optimization?: boolean;
}

export interface UnsignedIntentInput {
  zap: Address | string;
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  validAfter: bigint | number | string;
  deadline: bigint | number | string;
  recipient: Address | string;
  relayer: Address | string;
  maxRelayerFee?: bigint | number | string;
  maxGas: bigint | number | string;
  maxFeePerGas: bigint | number | string;
  policyHash: Hex;
  outAsset: Address | string;
  minOut: bigint | number | string;
}

export interface OpenZapIntent {
  zap: Address;
  chainId: bigint;
  nonce: bigint;
  validAfter: bigint;
  deadline: bigint;
  recipient: Address;
  relayer: Address;
  maxRelayerFee: bigint;
  maxGas: bigint;
  maxFeePerGas: bigint;
  policyHash: Hex;
  outAsset: Address;
  minOut: bigint;
}

export const OPENZAP_STEP_COMPONENTS: readonly object[];
export const OPENZAP_POLICY_COMPONENTS: readonly object[];
export const OPENZAP_INTENT_TYPES: {
  readonly OpenZapIntent: readonly { readonly name: string; readonly type: string }[];
};

export function buildOpenZapPolicy(input: OpenZapPolicyInput): OpenZapPolicy;
export function hashOpenZapPolicy(policy: OpenZapPolicy): Hex;
export function buildUnsignedOpenZapIntent(input: UnsignedIntentInput): {
  domain: TypedDataDomain;
  types: typeof OPENZAP_INTENT_TYPES;
  primaryType: "OpenZapIntent";
  message: OpenZapIntent;
};

export interface OpenZapsClientOptions {
  appUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenZapsClient {
  constructor(options?: OpenZapsClientOptions);
  readonly appUrl: string;
  readonly fetch: typeof globalThis.fetch;
  simulatePolicy(input: Record<string, unknown>): Promise<unknown>;
}
