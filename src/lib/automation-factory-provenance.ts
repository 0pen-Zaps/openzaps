import {
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export type AutomationFactoryProvenanceExpected = Readonly<{
  factory: Address;
  implementation: Address;
  version: string;
  adapterRegistry: Address;
  tokenAllowlist: Address;
  priceSourceRegistry: Address;
  lotteryPot: Address;
  stack: Readonly<{
    zaps: Address;
    zapsAdapter: Address;
  }> | null;
}>;

export type AutomationFactoryProvenanceReadback = Readonly<{
  factoryCode: Hex | null | undefined;
  implementationCode: Hex | null | undefined;
  adapterRegistryCode: Hex | null | undefined;
  tokenAllowlistCode: Hex | null | undefined;
  priceSourceRegistryCode: Hex | null | undefined;
  lotteryPotCode: Hex | null | undefined;
  activePriceSourceCode: Hex | null | undefined;
  activePriceSourceAllowed: boolean | null | undefined;
  factoryImplementation: Address | string | null | undefined;
  factoryImplementationHash: Hex | string | null | undefined;
  factoryVersion: string | null | undefined;
  factoryAdapters: Address | string | null | undefined;
  factoryTokens: Address | string | null | undefined;
  factoryPriceSources: Address | string | null | undefined;
  factoryLotteryPot: Address | string | null | undefined;
  implementationFactory: Address | string | null | undefined;
  implementationAdapters: Address | string | null | undefined;
  implementationTokens: Address | string | null | undefined;
  implementationPriceSources: Address | string | null | undefined;
  implementationLotteryPot: Address | string | null | undefined;
  stack: Readonly<{
    implementationZaps: Address | string | null | undefined;
    implementationZapsAdapter: Address | string | null | undefined;
    zapsCode: Hex | null | undefined;
    zapsAdapterCode: Hex | null | undefined;
    zapsAllowed: boolean | null | undefined;
    zapsAdapterAllowed: boolean | null | undefined;
  }> | null;
}>;

export type AutomationFeeLineage = Readonly<{
  intentKind: string;
  factory: Address;
  implementation: Address;
  priceSourceRegistry: Address;
  lotteryPot: Address;
  activePriceSource: Address;
  creationGateway: Address;
  creationPot: Address;
}>;

/**
 * Stable identity for the exact automation lineage whose asynchronous factory
 * and fee-gateway proof is being displayed. Address casing is deliberately
 * normalized so checksum-only differences do not invalidate a valid proof.
 */
export function automationFeeLineageKey(lineage: AutomationFeeLineage): string {
  return [
    lineage.intentKind,
    lineage.factory,
    lineage.implementation,
    lineage.priceSourceRegistry,
    lineage.lotteryPot,
    lineage.activePriceSource,
    lineage.creationGateway,
    lineage.creationPot,
  ].map((value) => value.toLowerCase()).join(":");
}

function hasRuntimeCode(value: unknown): value is Hex {
  return typeof value === "string" && value !== "0x" && isHex(value);
}

function isNonZeroAddress(value: unknown): value is Address {
  return (
    typeof value === "string"
    && isAddress(value)
    && !isAddressEqual(value, zeroAddress)
  );
}

function addressesMatch(expected: unknown, actual: unknown): boolean {
  return (
    isNonZeroAddress(expected)
    && isNonZeroAddress(actual)
    && isAddressEqual(expected, actual)
  );
}

/**
 * Verify one automation factory, its committed implementation, and every
 * immutable registry/pot binding from one pinned block. v3.2 additionally
 * proves the stack token/adapter code and current allowlist membership.
 */
export function matchesAutomationFactoryProvenance(
  expected: AutomationFactoryProvenanceExpected,
  readback: AutomationFactoryProvenanceReadback,
): boolean {
  try {
    const baseMatches =
      hasRuntimeCode(readback.factoryCode)
      && hasRuntimeCode(readback.implementationCode)
      && hasRuntimeCode(readback.adapterRegistryCode)
      && hasRuntimeCode(readback.tokenAllowlistCode)
      && hasRuntimeCode(readback.priceSourceRegistryCode)
      && hasRuntimeCode(readback.lotteryPotCode)
      && hasRuntimeCode(readback.activePriceSourceCode)
      && readback.activePriceSourceAllowed === true
      && addressesMatch(expected.implementation, readback.factoryImplementation)
      && typeof readback.factoryImplementationHash === "string"
      && isHex(readback.factoryImplementationHash)
      && keccak256(readback.implementationCode).toLowerCase()
        === readback.factoryImplementationHash.toLowerCase()
      && typeof expected.version === "string"
      && expected.version.length > 0
      && readback.factoryVersion === expected.version
      && addressesMatch(expected.adapterRegistry, readback.factoryAdapters)
      && addressesMatch(expected.tokenAllowlist, readback.factoryTokens)
      && addressesMatch(expected.priceSourceRegistry, readback.factoryPriceSources)
      && addressesMatch(expected.lotteryPot, readback.factoryLotteryPot)
      && addressesMatch(expected.factory, readback.implementationFactory)
      && addressesMatch(expected.adapterRegistry, readback.implementationAdapters)
      && addressesMatch(expected.tokenAllowlist, readback.implementationTokens)
      && addressesMatch(expected.priceSourceRegistry, readback.implementationPriceSources)
      && addressesMatch(expected.lotteryPot, readback.implementationLotteryPot);
    if (!baseMatches) return false;

    if (expected.stack === null || readback.stack === null) {
      return expected.stack === null && readback.stack === null;
    }
    return (
      hasRuntimeCode(readback.stack.zapsCode)
      && hasRuntimeCode(readback.stack.zapsAdapterCode)
      && readback.stack.zapsAllowed === true
      && readback.stack.zapsAdapterAllowed === true
      && addressesMatch(expected.stack.zaps, readback.stack.implementationZaps)
      && addressesMatch(expected.stack.zapsAdapter, readback.stack.implementationZapsAdapter)
    );
  } catch {
    return false;
  }
}
