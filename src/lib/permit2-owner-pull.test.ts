import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import {
  OPENZAP_ONE_SHOT_DOMAIN_VERSION,
  PERMIT2_MAX_DEADLINE_WINDOW_SECONDS,
  PERMIT2_OPENZAP_WITNESS_TYPE_STRING,
  PERMIT2_SIGNATURE_TRANSFER,
  buildOpenZapOneShotTypedData,
  buildPermit2OwnerPull,
  buildPermit2OwnerPullTypedData,
  hashOpenZapOneShotIntent,
  isPermit2NonceConsumed,
  permit2NonceBitmapPosition,
  type OpenZapOneShotIntent,
  type Permit2OwnerPullPermit,
} from "@/lib/permit2-owner-pull";
import { ROBINHOOD_LIQUIDITY } from "@/lib/robinhood";

const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as Address;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const TOKEN_IN = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const TOKEN_OUT = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07" as Address;
const POLICY_HASH =
  "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270" as Hex;
const NOW = 1_790_000_000n;

const intent: OpenZapOneShotIntent = {
  zap: ZAP,
  chainId: 4663n,
  nonce: 7n,
  validAfter: NOW,
  deadline: NOW + 600n,
  recipient: OWNER,
  relayer: "0x0000000000000000000000000000000000000000",
  maxRelayerFee: 0n,
  maxGas: 3_000_000n,
  maxFeePerGas: 10_000_000_000n,
  policyHash: POLICY_HASH,
  outAsset: TOKEN_OUT,
  minOut: 98_000_000_000_000_000n,
};

const permit: Permit2OwnerPullPermit = {
  permitted: { token: TOKEN_IN, amount: 100_000_000_000_000_000n },
  nonce: 41n,
  deadline: intent.deadline,
};

const DOMAIN_TYPEHASH = keccak256(
  stringToHex(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
const INTENT_TYPEHASH = keccak256(
  stringToHex(
    "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)",
  ),
);
const PERMIT2_DOMAIN_TYPEHASH = keccak256(
  stringToHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
);
const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
  stringToHex("TokenPermissions(address token,uint256 amount)"),
);
const OPENZAP_WITNESS_TYPEHASH = keccak256(
  stringToHex("OpenZapIntentWitness(bytes32 intentDigest)"),
);

function manualOpenZapDigest(value: OpenZapOneShotIntent): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(stringToHex("OpenZap")),
        keccak256(stringToHex("1")),
        value.chainId,
        value.zap,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        INTENT_TYPEHASH,
        value.zap,
        value.chainId,
        value.nonce,
        value.validAfter,
        value.deadline,
        value.recipient,
        value.relayer,
        value.maxRelayerFee,
        value.maxGas,
        value.maxFeePerGas,
        value.policyHash,
        value.outAsset,
        value.minOut,
      ],
    ),
  );
  return keccak256(`0x1901${domain.slice(2)}${structHash.slice(2)}` as Hex);
}

function manualPermit2Digest(
  value: OpenZapOneShotIntent,
  ownerPull: Permit2OwnerPullPermit,
): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        PERMIT2_DOMAIN_TYPEHASH,
        keccak256(stringToHex("Permit2")),
        value.chainId,
        PERMIT2_SIGNATURE_TRANSFER,
      ],
    ),
  );
  const tokenPermissions = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [
        TOKEN_PERMISSIONS_TYPEHASH,
        ownerPull.permitted.token,
        ownerPull.permitted.amount,
      ],
    ),
  );
  const witness = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [OPENZAP_WITNESS_TYPEHASH, manualOpenZapDigest(value)],
    ),
  );
  const permitTypehash = keccak256(
    stringToHex(
      `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,${PERMIT2_OPENZAP_WITNESS_TYPE_STRING}`,
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        permitTypehash,
        tokenPermissions,
        value.zap,
        ownerPull.nonce,
        ownerPull.deadline,
        witness,
      ],
    ),
  );
  return keccak256(`0x1901${domain.slice(2)}${structHash.slice(2)}` as Hex);
}

describe("Permit2 owner-pull typed data", () => {
  it("pins the same canonical Permit2 verifier as the Robinhood route config", () => {
    expect(PERMIT2_SIGNATURE_TRANSFER).toBe(ROBINHOOD_LIQUIDITY.permit2);
  });

  it("keeps the v1.2 candidate on the existing OpenZap domain version 1", () => {
    const typedData = buildOpenZapOneShotTypedData(intent);
    expect(OPENZAP_ONE_SHOT_DOMAIN_VERSION).toBe("1");
    expect(typedData.domain.version).toBe("1");
    expect(hashOpenZapOneShotIntent(intent)).toBe(manualOpenZapDigest(intent));
  });

  it("matches the Solidity Permit2 witness digest byte for byte", () => {
    expect(hashTypedData(buildPermit2OwnerPullTypedData(intent, permit))).toBe(
      manualPermit2Digest(intent, permit),
    );
  });

  it("binds the signature to capsule, exact intent, token, amount, nonce, and deadline", () => {
    const digest = hashTypedData(buildPermit2OwnerPullTypedData(intent, permit));
    const changed = [
      buildPermit2OwnerPullTypedData(
        { ...intent, zap: OWNER },
        permit,
      ),
      buildPermit2OwnerPullTypedData(
        { ...intent, nonce: intent.nonce + 1n },
        permit,
      ),
      buildPermit2OwnerPullTypedData(intent, {
        ...permit,
        permitted: { ...permit.permitted, token: TOKEN_OUT },
      }),
      buildPermit2OwnerPullTypedData(intent, {
        ...permit,
        permitted: { ...permit.permitted, amount: permit.permitted.amount + 1n },
      }),
      buildPermit2OwnerPullTypedData(intent, { ...permit, nonce: permit.nonce + 1n }),
      buildPermit2OwnerPullTypedData(intent, { ...permit, deadline: permit.deadline - 1n }),
    ];
    for (const typedData of changed) {
      expect(hashTypedData(typedData)).not.toBe(digest);
    }
  });

  it("constructs an exact step-zero permit and independent nonce readback", () => {
    const built = buildPermit2OwnerPull({
      intent,
      fundingStep: { token: TOKEN_IN, amount: permit.permitted.amount },
      permitNonce: permit.nonce,
      now: NOW,
    });
    expect(built.permit).toEqual(permit);
    expect(built.intentDigest).toBe(manualOpenZapDigest(intent));
    expect(hashTypedData(built.permitTypedData)).toBe(manualPermit2Digest(intent, permit));
    expect(built.nonceBitmap).toEqual({ wordPos: 0n, bitPos: 41, mask: 1n << 41n });
  });
});

describe("Permit2 owner-pull fail-closed bounds", () => {
  const build = (
    changes: Partial<Parameters<typeof buildPermit2OwnerPull>[0]> = {},
  ) =>
    buildPermit2OwnerPull({
      intent,
      fundingStep: { token: TOKEN_IN, amount: permit.permitted.amount },
      permitNonce: permit.nonce,
      now: NOW,
      ...changes,
    });

  it("rejects expired, over-intent, and over-one-hour permit deadlines", () => {
    expect(() => build({ permitDeadline: NOW })).toThrow(/future/);
    expect(() => build({ permitDeadline: intent.deadline + 1n })).toThrow(
      /outlive/,
    );
    const longIntent = {
      ...intent,
      deadline: NOW + PERMIT2_MAX_DEADLINE_WINDOW_SECONDS + 2n,
    };
    expect(() =>
      build({
        intent: longIntent,
        permitDeadline: NOW + PERMIT2_MAX_DEADLINE_WINDOW_SECONDS + 1n,
      }),
    ).toThrow(/one hour/);
  });

  it("rejects a non-positive amount and same-token settlement", () => {
    expect(() =>
      build({ fundingStep: { token: TOKEN_IN, amount: 0n } }),
    ).toThrow(/positive/);
    expect(() =>
      build({
        intent: { ...intent, outAsset: TOKEN_IN },
      }),
    ).toThrow(/differ/);
  });

  it("rejects an independently invalid Permit2 nonce", () => {
    expect(() => build({ permitNonce: -1n })).toThrow(/unsigned integer/);
  });

  it("locates high unordered nonces in Permit2's bitmap", () => {
    const nonce = 0x12345n;
    const position = permit2NonceBitmapPosition(nonce);
    expect(position).toEqual({
      wordPos: nonce >> 8n,
      bitPos: Number(nonce & 0xffn),
      mask: 1n << (nonce & 0xffn),
    });
    expect(isPermit2NonceConsumed(position.mask, nonce)).toBe(true);
    expect(isPermit2NonceConsumed(0n, nonce)).toBe(false);
  });
});
