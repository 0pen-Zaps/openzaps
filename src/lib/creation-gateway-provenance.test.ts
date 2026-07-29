import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress, type Hex } from "viem";

import {
  matchesCreationGatewayProvenance,
  type CreationGatewayProvenanceExpected,
  type CreationGatewayProvenanceReadback,
} from "@/lib/creation-gateway-provenance";

const GATEWAY = getAddress("0x1111111111111111111111111111111111111111");
const POT = getAddress("0x2222222222222222222222222222222222222222");
const FACTORY = getAddress("0x3333333333333333333333333333333333333333");
const ZAPS = getAddress("0x4444444444444444444444444444444444444444");
const OTHER = getAddress("0x5555555555555555555555555555555555555555");
const WETH = getAddress("0x6666666666666666666666666666666666666666");
const ADAPTER = getAddress("0x7777777777777777777777777777777777777777");

const EXPECTED: CreationGatewayProvenanceExpected = {
  gateway: GATEWAY,
  pot: POT,
  factory: FACTORY,
  weth: WETH,
  zaps: ZAPS,
  adapter: ADAPTER,
  fee: 10_000_000_000_000n,
  version: "1.0.0-candidate",
};

const READBACK: CreationGatewayProvenanceReadback = {
  gatewayCode: "0x6001600055",
  potCode: "0x6002600055",
  gatewayPot: POT,
  potGateway: GATEWAY,
  potZaps: ZAPS,
  gatewayFactory: FACTORY,
  gatewayWeth: WETH,
  gatewayZaps: ZAPS,
  gatewayAdapter: ADAPTER,
  fee: EXPECTED.fee,
  version: EXPECTED.version,
};

describe("matchesCreationGatewayProvenance", () => {
  it("accepts the exact configured bindings using viem address equality", () => {
    expect(
      matchesCreationGatewayProvenance(EXPECTED, {
        ...READBACK,
        gatewayPot: POT.toLowerCase(),
        potGateway: GATEWAY.toLowerCase(),
        potZaps: ZAPS.toLowerCase(),
        gatewayFactory: FACTORY.toLowerCase(),
        gatewayWeth: WETH.toLowerCase(),
        gatewayZaps: ZAPS.toLowerCase(),
        gatewayAdapter: ADAPTER.toLowerCase(),
      }),
    ).toBe(true);
  });

  it.each([
    ["gatewayCode", { gatewayCode: "0x" as Hex }],
    ["potCode", { potCode: "0x" as Hex }],
    ["gatewayPot", { gatewayPot: OTHER }],
    ["potGateway", { potGateway: OTHER }],
    ["potZaps", { potZaps: OTHER }],
    ["gatewayFactory", { gatewayFactory: OTHER }],
    ["gatewayWeth", { gatewayWeth: OTHER }],
    ["gatewayZaps", { gatewayZaps: OTHER }],
    ["gatewayAdapter", { gatewayAdapter: OTHER }],
    ["fee", { fee: EXPECTED.fee + 1n }],
    ["version", { version: `${EXPECTED.version}-lookalike` }],
  ] satisfies Array<[string, Partial<CreationGatewayProvenanceReadback>]>)(
    "rejects a mutated %s readback",
    (_field, mutation) => {
      expect(
        matchesCreationGatewayProvenance(EXPECTED, {
          ...READBACK,
          ...mutation,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["gateway", { gateway: OTHER }],
    ["pot", { pot: OTHER }],
    ["factory", { factory: OTHER }],
    ["weth", { weth: OTHER }],
    ["zaps", { zaps: OTHER }],
    ["adapter", { adapter: OTHER }],
    ["fee", { fee: EXPECTED.fee + 1n }],
    ["version", { version: `${EXPECTED.version}-other` }],
  ] satisfies Array<[string, Partial<CreationGatewayProvenanceExpected>]>)(
    "rejects a mutated expected %s value",
    (_field, mutation) => {
      expect(
        matchesCreationGatewayProvenance(
          {
            ...EXPECTED,
            ...mutation,
          },
          READBACK,
        ),
      ).toBe(false);
    },
  );

  it("fails closed for malformed, missing, zero-address, and invalid bytecode inputs", () => {
    expect(
      matchesCreationGatewayProvenance(EXPECTED, {
        ...READBACK,
        potGateway: "not-an-address",
      }),
    ).toBe(false);
    expect(
      matchesCreationGatewayProvenance(EXPECTED, {
        ...READBACK,
        gatewayCode: "0xzz" as Hex,
      }),
    ).toBe(false);
    expect(
      matchesCreationGatewayProvenance(EXPECTED, {
        ...READBACK,
        potCode: undefined,
      }),
    ).toBe(false);
    expect(
      matchesCreationGatewayProvenance(
        {
          ...EXPECTED,
          gateway: zeroAddress,
        },
        {
          ...READBACK,
          potGateway: zeroAddress,
        },
      ),
    ).toBe(false);
  });

  it("returns false instead of throwing for untyped null readback data", () => {
    expect(
      matchesCreationGatewayProvenance(
        EXPECTED,
        null as unknown as CreationGatewayProvenanceReadback,
      ),
    ).toBe(false);
  });
});
