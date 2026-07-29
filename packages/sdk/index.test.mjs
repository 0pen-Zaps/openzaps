import { test } from "node:test";
import assert from "node:assert/strict";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
} from "viem";

import {
  PERMIT2_ADDRESS,
  buildOpenZapPolicy,
  buildUnsignedOpenZapIntent,
  buildUnsignedPermit2OwnerPull,
  hashOpenZapPolicy,
} from "./index.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const ZAP = "0x2000000000000000000000000000000000000002";
const ADAPTER = "0x3000000000000000000000000000000000000003";
const TOKEN_IN = "0x4000000000000000000000000000000000000004";
const TOKEN_OUT = "0x5000000000000000000000000000000000000005";
const RECIPIENT = "0x6000000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

function fixture() {
  const policy = buildOpenZapPolicy({
    owner: OWNER,
    recipient: RECIPIENT,
    adapter: ADAPTER,
    tokenIn: TOKEN_IN,
    amountIn: 100n,
    trackedAssets: [TOKEN_IN, TOKEN_OUT],
  });
  const intent = buildUnsignedOpenZapIntent({
    zap: ZAP,
    chainId: 4663,
    nonce: 7n,
    validAfter: 1_000n,
    deadline: 4_000n,
    recipient: RECIPIENT,
    relayer: ZERO,
    maxRelayerFee: 0n,
    maxGas: 3_000_000n,
    maxFeePerGas: 2_000_000_000n,
    policyHash: hashOpenZapPolicy(policy),
    outAsset: TOKEN_OUT,
    minOut: 90n,
  });
  return { policy, intent };
}

test("Permit2 owner-pull typed data pins the capsule, first funding leg, and OpenZap digest", () => {
  const { policy, intent } = fixture();
  const permit = buildUnsignedPermit2OwnerPull({
    policy,
    intent,
    nonce: 11n,
    deadline: 3_600n,
    nowSeconds: 1_000n,
  });

  assert.equal(permit.domain.name, "Permit2");
  assert.equal(permit.domain.chainId, 4663);
  assert.equal(permit.domain.verifyingContract, PERMIT2_ADDRESS);
  assert.deepEqual(permit.message.permitted, { token: TOKEN_IN, amount: 100n });
  assert.equal(permit.message.spender, ZAP);
  assert.equal(permit.message.witness.intentDigest, hashTypedData(intent));

  // Cross-check viem's nested EIP-712 encoding against Permit2's documented witness type string.
  const tokenPermissionsTypehash = keccak256(
    stringToHex("TokenPermissions(address token,uint256 amount)"),
  );
  const witnessTypehash = keccak256(
    stringToHex("OpenZapIntentWitness(bytes32 intentDigest)"),
  );
  const permitTypehash = keccak256(
    stringToHex(
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,OpenZapIntentWitness witness)"
        + "OpenZapIntentWitness(bytes32 intentDigest)"
        + "TokenPermissions(address token,uint256 amount)",
    ),
  );
  const tokenPermissionsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [tokenPermissionsTypehash, TOKEN_IN, 100n],
    ),
  );
  const witnessHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [witnessTypehash, hashTypedData(intent)],
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
      [permitTypehash, tokenPermissionsHash, ZAP, 11n, 3_600n, witnessHash],
    ),
  );
  const domainTypehash = keccak256(
    stringToHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
  );
  const domainHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypehash, keccak256(stringToHex("Permit2")), 4663n, PERMIT2_ADDRESS],
    ),
  );
  assert.equal(hashTypedData(permit), keccak256(concatHex(["0x1901", domainHash, structHash])));
});

test("Permit2 owner-pull builder rejects scope and deadline drift", () => {
  const { policy, intent } = fixture();
  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        policy: { ...policy, maxRelayerFeeCap: 1n },
        intent,
        nonce: 1n,
        deadline: 2_000n,
        nowSeconds: 1_000n,
      }),
    /policyHash/,
  );
  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        policy,
        intent,
        nonce: 1n,
        deadline: 4_001n,
        nowSeconds: 1_000n,
      }),
    /cannot exceed/,
  );
  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        policy,
        intent,
        nonce: 1n,
        deadline: 4_000n,
        nowSeconds: 1n,
      }),
    /no more than one hour/,
  );
});

test("Permit2 owner-pull builder rejects noncanonical signing envelopes", () => {
  const { policy, intent } = fixture();
  const input = {
    policy,
    intent,
    nonce: 1n,
    deadline: 2_000n,
    nowSeconds: 1_000n,
  };

  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        ...input,
        permit2Address: "0x7000000000000000000000000000000000000007",
      }),
    /fixed to the canonical/,
  );
  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        ...input,
        intent: {
          ...intent,
          domain: { ...intent.domain, chainId: 8453 },
        },
      }),
    /domain chainId must equal/,
  );
  assert.throws(
    () =>
      buildUnsignedPermit2OwnerPull({
        ...input,
        intent: {
          ...intent,
          types: {
            OpenZapIntent: [...intent.types.OpenZapIntent].reverse(),
          },
        },
      }),
    /exactly match OPENZAP_INTENT_TYPES/,
  );
});
