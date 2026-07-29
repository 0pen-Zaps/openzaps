import {
  isAddress,
  isAddressEqual,
  isHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export type CreationGatewayProvenanceExpected = Readonly<{
  gateway: Address;
  pot: Address;
  factory: Address;
  weth: Address;
  zaps: Address;
  adapter: Address;
  fee: bigint;
  version: string;
}>;

export type CreationGatewayProvenanceReadback = Readonly<{
  gatewayCode: Hex | null | undefined;
  potCode: Hex | null | undefined;
  gatewayPot: Address | string | null | undefined;
  potGateway: Address | string | null | undefined;
  potZaps: Address | string | null | undefined;
  gatewayFactory: Address | string | null | undefined;
  gatewayWeth: Address | string | null | undefined;
  gatewayZaps: Address | string | null | undefined;
  gatewayAdapter: Address | string | null | undefined;
  fee: bigint | null | undefined;
  version: string | null | undefined;
}>;

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
 * Verify the app's creation-gateway bindings from independently read onchain
 * values. Every check is required; malformed or missing RPC data fails closed.
 *
 * Runtime bytecode is checked for presence rather than identity because the
 * canonical contract addresses, immutable bindings, fee, and version are the
 * provenance anchors supplied by the app configuration.
 */
export function matchesCreationGatewayProvenance(
  expected: CreationGatewayProvenanceExpected,
  readback: CreationGatewayProvenanceReadback,
): boolean {
  try {
    return (
      hasRuntimeCode(readback.gatewayCode)
      && hasRuntimeCode(readback.potCode)
      && addressesMatch(expected.pot, readback.gatewayPot)
      && addressesMatch(expected.gateway, readback.potGateway)
      && addressesMatch(expected.zaps, readback.potZaps)
      && addressesMatch(expected.factory, readback.gatewayFactory)
      && addressesMatch(expected.weth, readback.gatewayWeth)
      && addressesMatch(expected.zaps, readback.gatewayZaps)
      && addressesMatch(expected.adapter, readback.gatewayAdapter)
      && typeof expected.fee === "bigint"
      && expected.fee > 0n
      && readback.fee === expected.fee
      && typeof expected.version === "string"
      && expected.version.length > 0
      && readback.version === expected.version
    );
  } catch {
    return false;
  }
}
