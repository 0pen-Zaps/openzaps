import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

export type CapsuleLineageId = "v1.1" | "v1.2" | "v3" | "v3.1" | "v3.2";
export type HaltCapableLineageId = "v1.2" | "v3.2";
export type PolicyHaltStatus = "unsupported" | "active" | "halted" | "unavailable";

export interface PolicyHaltEventLike {
  emitter: Address;
  owner: Address;
  policyHash: Hex;
}

export interface PolicyHaltCreationLike {
  zap: Address;
  owner: Address;
  policyHash: Hex;
}

export const POLICY_HALT_CONFIRMATION = "HALT";

/** Only deployed v1.2 and configured v3.2 define the one-way policy stop. */
export function isHaltCapableLineage(
  lineage: CapsuleLineageId | "unknown",
): lineage is HaltCapableLineageId {
  return lineage === "v1.2" || lineage === "v3.2";
}

/**
 * Turn a pinned boolean into the public status vocabulary without allowing an
 * unsupported lineage to masquerade as active. `null` always means the
 * authoritative read was unavailable.
 */
export function policyHaltStatus(
  lineage: CapsuleLineageId | "unknown",
  halted: boolean | null,
): PolicyHaltStatus {
  if (!isHaltCapableLineage(lineage)) {
    if (halted !== null) {
      throw new Error(`${lineage} does not expose the canonical policy-halt surface.`);
    }
    return "unsupported";
  }
  if (halted === null) return "unavailable";
  return halted ? "halted" : "active";
}

/**
 * Exact provenance check for PolicyHalted. Event shape alone is not authority:
 * the emitter, owner, and immutable policy hash must all match ZapCreated.
 */
export function matchesPolicyHaltCreation(
  event: PolicyHaltEventLike,
  creation: PolicyHaltCreationLike,
): boolean {
  return (
    isAddressEqual(event.emitter, creation.zap)
    && isAddressEqual(event.owner, creation.owner)
    && event.policyHash.toLowerCase() === creation.policyHash.toLowerCase()
  );
}

export function normalizedPolicyHaltOwner(owner: Address): Address {
  return getAddress(owner);
}
