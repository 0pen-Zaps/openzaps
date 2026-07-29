import {
  getAddress,
  hashTypedData,
  isAddressEqual,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

/**
 * Canonical Permit2 deployment used by the v1.2 candidate on Robinhood Chain.
 * This is intentionally not configurable: a different verifier is a different
 * authorization surface and must never be selected by wallet/local state.
 */
export const PERMIT2_SIGNATURE_TRANSFER = getAddress(
  "0x000000000022D473030F116dDEE9F6B43aC78BA3",
);

/** Mirrors OpenZap.PERMIT2_MAX_DEADLINE_WINDOW. */
export const PERMIT2_MAX_DEADLINE_WINDOW_SECONDS = 60n * 60n;
/** The v1.2 candidate deliberately preserves the existing one-shot intent domain. */
export const OPENZAP_ONE_SHOT_DOMAIN_VERSION = "1";

/**
 * Exact suffix passed by OpenZap to Permit2's `permitWitnessTransferFrom`.
 * Exported as an audit anchor; wallets derive the same full primary type from
 * `PERMIT2_OWNER_PULL_TYPES` below.
 */
export const PERMIT2_OPENZAP_WITNESS_TYPE_STRING =
  "OpenZapIntentWitness witness)OpenZapIntentWitness(bytes32 intentDigest)TokenPermissions(address token,uint256 amount)";

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Existing v1/v1.1 one-shot intent, unchanged by the v1.2 owner-pull path. */
export interface OpenZapOneShotIntent {
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

export interface Permit2TokenPermissions {
  token: Address;
  amount: bigint;
}

/** Tuple consumed by OpenZap.executeWithPermit2. */
export interface Permit2OwnerPullPermit {
  permitted: Permit2TokenPermissions;
  /** Permit2's unordered nonce; independent from `intent.nonce`. */
  nonce: bigint;
  deadline: bigint;
}

export interface Permit2NonceBitmapPosition {
  /** Permit2 nonce bitmap word (`nonce >> 8`). */
  wordPos: bigint;
  /** Bit within the word (`nonce & 0xff`). */
  bitPos: number;
  mask: bigint;
}

export interface BuildPermit2OwnerPullInput {
  intent: OpenZapOneShotIntent;
  /**
   * Step zero from a provenance-verified v1.2 capsule. The builder fixes the
   * permit to this exact token and amount; callers must not source it from URL
   * or persisted metadata.
   */
  fundingStep: {
    token: Address;
    amount: bigint;
  };
  /** Independent random Permit2 unordered nonce. */
  permitNonce: bigint;
  /** Pinned/current chain timestamp in seconds. */
  now: bigint;
  /** Defaults to the intent deadline; may only shorten it. */
  permitDeadline?: bigint;
}

export const OPENZAP_ONE_SHOT_INTENT_TYPES = {
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
} as const;

/**
 * Full EIP-712 graph Permit2 hashes for a witness transfer. EIP-712 sorts
 * referenced types by name, producing exactly:
 *
 * PermitWitnessTransferFrom(...,OpenZapIntentWitness witness)
 * OpenZapIntentWitness(bytes32 intentDigest)
 * TokenPermissions(address token,uint256 amount)
 */
export const PERMIT2_OWNER_PULL_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "OpenZapIntentWitness" },
  ],
  OpenZapIntentWitness: [{ name: "intentDigest", type: "bytes32" }],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

/** Domain used by the unchanged OpenZap one-shot authorization. */
export function openZapOneShotDomain(
  chainId: number | bigint,
  zap: Address,
): TypedDataDomain {
  return {
    name: "OpenZap",
    version: OPENZAP_ONE_SHOT_DOMAIN_VERSION,
    chainId: safeChainId(chainId),
    verifyingContract: getAddress(zap),
  };
}

/** Everything a wallet needs for the base owner-signed OpenZap intent. */
export function buildOpenZapOneShotTypedData(intent: OpenZapOneShotIntent) {
  assertOpenZapIntentWidths(intent);
  return {
    domain: openZapOneShotDomain(intent.chainId, intent.zap),
    types: OPENZAP_ONE_SHOT_INTENT_TYPES,
    primaryType: "OpenZapIntent",
    message: intent,
  } as const;
}

/** Digest OpenZap places in the Permit2 witness. */
export function hashOpenZapOneShotIntent(intent: OpenZapOneShotIntent): Hex {
  return hashTypedData(buildOpenZapOneShotTypedData(intent));
}

/** Permit2 domain: name + chain + canonical verifier, with no version field. */
export function permit2SignatureTransferDomain(
  chainId: number | bigint,
): TypedDataDomain {
  return {
    name: "Permit2",
    chainId: safeChainId(chainId),
    verifyingContract: PERMIT2_SIGNATURE_TRANSFER,
  };
}

/**
 * Build the Permit2 witness signature payload. `spender` is deliberately not a
 * parameter: Permit2 sees the capsule as msg.sender, so the signature must bind
 * the exact capsule from the witnessed intent.
 */
export function buildPermit2OwnerPullTypedData(
  intent: OpenZapOneShotIntent,
  permit: Permit2OwnerPullPermit,
) {
  assertOpenZapIntentWidths(intent);
  assertUint(permit.permitted.amount, MAX_UINT256, "Permit2 amount");
  assertUint(permit.nonce, MAX_UINT256, "Permit2 nonce");
  assertUint(permit.deadline, MAX_UINT256, "Permit2 deadline");

  return {
    domain: permit2SignatureTransferDomain(intent.chainId),
    types: PERMIT2_OWNER_PULL_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: permit.permitted,
      spender: intent.zap,
      nonce: permit.nonce,
      deadline: permit.deadline,
      witness: { intentDigest: hashOpenZapOneShotIntent(intent) },
    },
  } as const;
}

/**
 * Construct both owner signature payloads and the exact contract permit tuple.
 *
 * This helper does not establish capsule provenance. The caller must first
 * verify a v1.2 factory, implementation commitment, clone runtime, owner,
 * policy, and active halt state at one pinned block.
 */
export function buildPermit2OwnerPull(input: BuildPermit2OwnerPullInput) {
  const { intent, fundingStep, permitNonce, now } = input;
  const token = getAddress(fundingStep.token);
  const deadline = input.permitDeadline ?? intent.deadline;

  assertUint(now, MAX_UINT256, "Current timestamp");
  if (fundingStep.amount <= 0n) {
    throw new Error("Permit2 funding amount must be positive.");
  }
  assertUint(fundingStep.amount, MAX_UINT256, "Permit2 funding amount");
  assertUint(permitNonce, MAX_UINT256, "Permit2 nonce");
  assertUint(deadline, MAX_UINT256, "Permit2 deadline");

  if (isAddressEqual(token, intent.outAsset)) {
    throw new Error("Permit2 input token must differ from the intent output asset.");
  }
  if (deadline <= now) {
    throw new Error("Permit2 deadline must be in the future.");
  }
  if (deadline > intent.deadline) {
    throw new Error("Permit2 deadline cannot outlive the OpenZap intent.");
  }
  if (deadline > now + PERMIT2_MAX_DEADLINE_WINDOW_SECONDS) {
    throw new Error("Permit2 deadline cannot be more than one hour away.");
  }
  if (deadline < intent.validAfter) {
    throw new Error("Permit2 deadline cannot precede the intent validity window.");
  }

  const permit: Permit2OwnerPullPermit = {
    permitted: { token, amount: fundingStep.amount },
    nonce: permitNonce,
    deadline,
  };

  return {
    permit,
    intentDigest: hashOpenZapOneShotIntent(intent),
    intentTypedData: buildOpenZapOneShotTypedData(intent),
    permitTypedData: buildPermit2OwnerPullTypedData(intent, permit),
    nonceBitmap: permit2NonceBitmapPosition(permitNonce),
  } as const;
}

/** Locate an unordered Permit2 nonce for post-receipt readback. */
export function permit2NonceBitmapPosition(
  nonce: bigint,
): Permit2NonceBitmapPosition {
  assertUint(nonce, MAX_UINT256, "Permit2 nonce");
  const bitPos = Number(nonce & 0xffn);
  return {
    wordPos: nonce >> 8n,
    bitPos,
    mask: 1n << BigInt(bitPos),
  };
}

/** Whether the nonce is consumed in the word returned by Permit2.nonceBitmap. */
export function isPermit2NonceConsumed(bitmap: bigint, nonce: bigint): boolean {
  assertUint(bitmap, MAX_UINT256, "Permit2 nonce bitmap");
  return (bitmap & permit2NonceBitmapPosition(nonce).mask) !== 0n;
}

function assertOpenZapIntentWidths(intent: OpenZapOneShotIntent): void {
  safeChainId(intent.chainId);
  assertUint(intent.nonce, MAX_UINT256, "OpenZap nonce");
  assertUint(intent.validAfter, MAX_UINT64, "OpenZap validAfter");
  assertUint(intent.deadline, MAX_UINT64, "OpenZap deadline");
  assertUint(intent.maxRelayerFee, MAX_UINT256, "OpenZap maxRelayerFee");
  assertUint(intent.maxGas, MAX_UINT256, "OpenZap maxGas");
  assertUint(intent.maxFeePerGas, MAX_UINT256, "OpenZap maxFeePerGas");
  assertUint(intent.minOut, MAX_UINT256, "OpenZap minOut");
}

function assertUint(value: bigint, max: bigint, label: string): void {
  if (value < 0n || value > max) {
    throw new Error(`${label} is outside its unsigned integer range.`);
  }
}

function safeChainId(chainId: number | bigint): number {
  const value = typeof chainId === "number" ? chainId : Number(chainId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Chain ID must be a positive safe integer.");
  }
  return value;
}
