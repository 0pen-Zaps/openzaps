import {
  encodeAbiParameters,
  getAddress,
  keccak256,
} from "viem";

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Field order is signature-bearing. This mirrors
 * contracts/src/libraries/OpenZapTypes.sol exactly.
 */
export const OPENZAP_STEP_COMPONENTS = [
  { name: "adapter", type: "address" },
  { name: "tokenIn", type: "address" },
  { name: "spender", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "data", type: "bytes" },
];

export const OPENZAP_POLICY_COMPONENTS = [
  { name: "owner", type: "address" },
  { name: "recipient", type: "address" },
  { name: "maxRelayerFeeCap", type: "uint256" },
  { name: "optimization", type: "bool" },
  { name: "trackedAssets", type: "address[]" },
  { name: "steps", type: "tuple[]", components: OPENZAP_STEP_COMPONENTS },
];

export const OPENZAP_INTENT_TYPES = {
  OpenZapIntent: [
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
  ],
};

const POLICY_PARAMETER = {
  name: "policy",
  type: "tuple",
  components: OPENZAP_POLICY_COMPONENTS,
};

/**
 * Compile the exact Solidity Policy tuple. This function is deliberately pure:
 * it cannot establish whether an adapter or token is still allowlisted. Use the
 * simulation endpoint for those block-pinned chain reads.
 */
export function buildOpenZapPolicy(input) {
  const amountIn = asPositiveUint(input.amountIn, "amountIn");
  const maxRelayerFeeCap = asUint(input.maxRelayerFeeCap ?? 0n, "maxRelayerFeeCap");
  const owner = nonzeroAddress(input.owner, "owner");
  const recipient = nonzeroAddress(input.recipient ?? input.owner, "recipient");
  const adapter = nonzeroAddress(input.adapter, "adapter");
  const spender = nonzeroAddress(input.spender ?? input.adapter, "spender");
  const tokenIn = nonzeroAddress(input.tokenIn, "tokenIn");
  if (adapter !== spender) {
    throw new Error("spender must equal adapter for the live OpenZap policy.");
  }
  if (input.optimization === false) {
    throw new Error("optimization must be true for the live OpenZap policy.");
  }
  const trackedAssets = input.trackedAssets.map((address, index) =>
    nonzeroAddress(address, `trackedAssets[${index}]`),
  );
  if (trackedAssets.length === 0) throw new Error("trackedAssets cannot be empty.");
  if (new Set(trackedAssets.map((address) => address.toLowerCase())).size !== trackedAssets.length) {
    throw new Error("trackedAssets cannot contain duplicates.");
  }
  const data = input.data ?? "0x";
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error("data must be even-length hex bytes.");
  }

  return {
    owner,
    recipient,
    maxRelayerFeeCap,
    optimization: true,
    trackedAssets,
    steps: [
      {
        adapter,
        tokenIn,
        spender,
        amountIn,
        data,
      },
    ],
  };
}

/** Solidity-exact `keccak256(abi.encode(policy))`. */
export function hashOpenZapPolicy(policy) {
  return keccak256(encodeAbiParameters([POLICY_PARAMETER], [policy]));
}

/**
 * Produce wallet-ready EIP-712 data without requesting a signature.
 * Returning this object cannot authorize or submit anything.
 */
export function buildUnsignedOpenZapIntent(input) {
  const chainId = asUint(input.chainId, "chainId");
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("chainId must fit a JavaScript safe integer for EIP-712.");
  }
  const relayer = getAddress(input.relayer);
  const maxRelayerFee = asUint(input.maxRelayerFee ?? 0n, "maxRelayerFee");
  if (maxRelayerFee > 0n && relayer.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("A nonzero maxRelayerFee requires a nonzero relayer.");
  }
  if (typeof input.policyHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.policyHash)) {
    throw new Error("policyHash must be 32-byte hex.");
  }
  const message = {
    zap: nonzeroAddress(input.zap, "zap"),
    chainId,
    nonce: asUint(input.nonce, "nonce"),
    validAfter: asUint(input.validAfter, "validAfter", MAX_UINT64),
    deadline: asPositiveUint(input.deadline, "deadline", MAX_UINT64),
    recipient: nonzeroAddress(input.recipient, "recipient"),
    relayer,
    maxRelayerFee,
    maxGas: asPositiveUint(input.maxGas, "maxGas"),
    maxFeePerGas: asPositiveUint(input.maxFeePerGas, "maxFeePerGas"),
    policyHash: input.policyHash,
    outAsset: getAddress(input.outAsset),
    minOut: asUint(input.minOut, "minOut"),
  };
  if (message.deadline <= message.validAfter) {
    throw new Error("deadline must be after validAfter.");
  }
  return {
    domain: {
      name: "OpenZap",
      version: "1",
      chainId: Number(message.chainId),
      verifyingContract: message.zap,
    },
    types: OPENZAP_INTENT_TYPES,
    primaryType: "OpenZapIntent",
    message,
  };
}

/**
 * Minimal read-only API client for the public OpenZaps discovery surface. This
 * package has no signing or transaction-broadcast method.
 */
export class OpenZapsClient {
  constructor(options = {}) {
    this.appUrl = (options.appUrl ?? "https://www.0xzaps.com").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") throw new Error("A fetch implementation is required.");
  }

  async simulatePolicy(input) {
    const response = await this.fetch(`${this.appUrl}/api/policies/simulate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error ?? `Policy simulation failed with HTTP ${response.status}.`);
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  }
}

function asUint(value, field, max = MAX_UINT256) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be an unsigned integer.`);
  }
  if (parsed < 0n) throw new Error(`${field} must be an unsigned integer.`);
  if (parsed > max) throw new Error(`${field} exceeds its Solidity integer width.`);
  return parsed;
}

function asPositiveUint(value, field, max = MAX_UINT256) {
  const parsed = asUint(value, field, max);
  if (parsed === 0n) throw new Error(`${field} must be greater than zero.`);
  return parsed;
}

function nonzeroAddress(value, field) {
  const address = getAddress(value);
  if (address.toLowerCase() === ZERO_ADDRESS) throw new Error(`${field} cannot be the zero address.`);
  return address;
}
