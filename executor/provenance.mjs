// Independent executor-side capsule provenance.
//
// The hosted relay is untrusted input. A valid signature over an ABI-compatible
// attacker contract proves only that the attacker owns that contract; it does
// not prove the target is an OpenZap capsule. Before simulation or broadcast,
// the executor therefore proves all of:
//   * intent kind -> exact configured factory + implementation lineage;
//   * factory commitment -> exact implementation runtime hash;
//   * target runtime -> exact EIP-1167 clone of that implementation;
//   * target FACTORY/policyHash -> expected immutable values;
//   * canonical factory ZapCreated log -> target, owner, policy, implementation.
import { getAddress, isAddressEqual, keccak256, zeroAddress } from "viem";

import { openZapFactoryV3Abi, openZapV3Abi, zapCreatedEvent } from "./abi.mjs";

const ACTIVITY_FROM_BLOCK = 15_900_000n;
const MAX_VERIFIED_CACHE = 4_096;
const verified = new Map();

export class CapsuleProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapsuleProvenanceError";
  }
}

function lineageKey(kind) {
  if (kind === "recurring" || kind === "trigger") return "v3";
  if (kind === "recurring-relative") return "v3.1";
  if (kind === "recurring-stack") return "v3.2";
  throw new CapsuleProvenanceError(`intent kind ${String(kind)} has no configured capsule lineage`);
}

function configuredLineage(item, cfg) {
  const key = lineageKey(item.kind);
  const configured = cfg?.capsuleLineages?.[key];
  if (!configured?.factory || !configured?.implementation) {
    throw new CapsuleProvenanceError(`${key} capsule lineage is not configured`);
  }
  let factory;
  let implementation;
  try {
    factory = getAddress(String(configured.factory).toLowerCase());
    implementation = getAddress(String(configured.implementation).toLowerCase());
  } catch {
    throw new CapsuleProvenanceError(`${key} capsule lineage contains an invalid address`);
  }
  if (factory === zeroAddress || implementation === zeroAddress) {
    throw new CapsuleProvenanceError(`${key} capsule lineage is not configured`);
  }
  return { key, factory, implementation };
}

function expectedCloneRuntime(implementation) {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

function remember(key, proof) {
  verified.set(key, proof);
  while (verified.size > MAX_VERIFIED_CACHE) {
    const oldest = verified.keys().next().value;
    if (oldest === undefined) break;
    verified.delete(oldest);
  }
  return proof;
}

/** Test-only cache reset; it does not weaken the production path. */
export function clearCapsuleProvenanceCache() {
  verified.clear();
}

/**
 * Prove an untrusted intent target is a canonical capsule at one captured block.
 * Successful immutable proofs are cached for this process; failures never are.
 */
export async function verifyExecutionTargetProvenance(client, item, cfg) {
  const expected = configuredLineage(item, cfg);
  let zap;
  try {
    zap = getAddress(String(item?.intent?.zap).toLowerCase());
  } catch {
    throw new CapsuleProvenanceError("intent target is not an EVM address");
  }
  const policyHash = item?.intent?.policyHash;
  if (typeof policyHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(policyHash)) {
    throw new CapsuleProvenanceError("intent policyHash is malformed");
  }

  const cacheKey = [
    String(cfg?.chainId),
    expected.key,
    expected.factory.toLowerCase(),
    expected.implementation.toLowerCase(),
    zap.toLowerCase(),
    policyHash.toLowerCase(),
  ].join(":");
  const cached = verified.get(cacheKey);
  if (cached) return cached;

  let atBlock;
  try {
    atBlock = await client.getBlockNumber();
  } catch {
    throw new CapsuleProvenanceError("chain head is unavailable; provenance failed closed");
  }

  let values;
  try {
    values = await Promise.all([
      client.readContract({
        address: expected.factory,
        abi: openZapFactoryV3Abi,
        functionName: "implementation",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: expected.factory,
        abi: openZapFactoryV3Abi,
        functionName: "implCodeHash",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "FACTORY",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "owner",
        blockNumber: atBlock,
      }),
      client.readContract({
        address: zap,
        abi: openZapV3Abi,
        functionName: "policyHash",
        blockNumber: atBlock,
      }),
      client.getBytecode({ address: expected.factory, blockNumber: atBlock }),
      client.getBytecode({ address: expected.implementation, blockNumber: atBlock }),
      client.getBytecode({ address: zap, blockNumber: atBlock }),
      client.getLogs({
        address: expected.factory,
        event: zapCreatedEvent,
        args: { zap },
        fromBlock: ACTIVITY_FROM_BLOCK,
        toBlock: atBlock,
        strict: true,
      }),
    ]);
  } catch {
    throw new CapsuleProvenanceError("canonical capsule provenance could not be read; refusing execution");
  }

  const [
    factoryImplementation,
    committedImplementationHash,
    capsuleFactory,
    capsuleOwner,
    capsulePolicyHash,
    factoryRuntime,
    implementationRuntime,
    capsuleRuntime,
    creationLogs,
  ] = values;

  if (!factoryRuntime || factoryRuntime === "0x") {
    throw new CapsuleProvenanceError("configured capsule factory has no runtime code");
  }
  if (!isAddressEqual(factoryImplementation, expected.implementation)) {
    throw new CapsuleProvenanceError("factory implementation does not match the configured lineage");
  }
  if (!isAddressEqual(capsuleFactory, expected.factory)) {
    throw new CapsuleProvenanceError("capsule FACTORY does not match the configured lineage");
  }
  if (String(capsulePolicyHash).toLowerCase() !== policyHash.toLowerCase()) {
    throw new CapsuleProvenanceError("capsule policyHash does not match the signed intent");
  }
  if (!implementationRuntime || implementationRuntime === "0x") {
    throw new CapsuleProvenanceError("configured capsule implementation has no runtime code");
  }
  const implementationCodeHash = keccak256(implementationRuntime);
  if (implementationCodeHash.toLowerCase() !== String(committedImplementationHash).toLowerCase()) {
    throw new CapsuleProvenanceError("implementation runtime does not match the factory commitment");
  }
  if (!capsuleRuntime || capsuleRuntime.toLowerCase() !== expectedCloneRuntime(expected.implementation)) {
    throw new CapsuleProvenanceError("intent target is not the expected canonical clone");
  }

  const creation = creationLogs.find((log) =>
    log.args?.zap
    && isAddressEqual(log.args.zap, zap)
    && log.args.owner
    && isAddressEqual(log.args.owner, capsuleOwner)
    && typeof log.args.policyHash === "string"
    && log.args.policyHash.toLowerCase() === policyHash.toLowerCase()
    && typeof log.args.implCodeHash === "string"
    && log.args.implCodeHash.toLowerCase() === implementationCodeHash.toLowerCase()
  );
  if (!creation?.transactionHash || creation.blockNumber === null) {
    throw new CapsuleProvenanceError("canonical factory has no matching ZapCreated provenance");
  }

  return remember(cacheKey, {
    verified: true,
    lineage: expected.key,
    factory: expected.factory,
    implementation: expected.implementation,
    owner: capsuleOwner,
    policyHash: capsulePolicyHash,
    blockNumber: atBlock,
    creationTxHash: creation.transactionHash,
    creationBlock: creation.blockNumber,
  });
}
