import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Hex } from "viem";

import {
  automationFeeLineageKey,
  matchesAutomationFactoryProvenance,
  type AutomationFeeLineage,
  type AutomationFactoryProvenanceExpected,
  type AutomationFactoryProvenanceReadback,
} from "@/lib/automation-factory-provenance";

const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const FACTORY = address("1");
const IMPLEMENTATION = address("2");
const ADAPTERS = address("3");
const TOKENS = address("4");
const PRICE_SOURCES = address("5");
const POT = address("6");
const ZAPS = address("7");
const ZAPS_ADAPTER = address("8");
const OTHER = address("9");
const CODE = "0x6001600055" as Hex;

const FEE_LINEAGE: AutomationFeeLineage = {
  intentKind: "recurring-stack",
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  priceSourceRegistry: PRICE_SOURCES,
  lotteryPot: POT,
  activePriceSource: ZAPS,
  creationGateway: ZAPS_ADAPTER,
  creationPot: OTHER,
};

const EXPECTED: AutomationFactoryProvenanceExpected = {
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  version: "3.2.0-candidate",
  adapterRegistry: ADAPTERS,
  tokenAllowlist: TOKENS,
  priceSourceRegistry: PRICE_SOURCES,
  lotteryPot: POT,
  stack: { zaps: ZAPS, zapsAdapter: ZAPS_ADAPTER },
};

const READBACK: AutomationFactoryProvenanceReadback = {
  factoryCode: CODE,
  implementationCode: CODE,
  adapterRegistryCode: CODE,
  tokenAllowlistCode: CODE,
  priceSourceRegistryCode: CODE,
  lotteryPotCode: CODE,
  activePriceSourceCode: CODE,
  activePriceSourceAllowed: true,
  factoryImplementation: IMPLEMENTATION,
  factoryImplementationHash: keccak256(CODE),
  factoryVersion: EXPECTED.version,
  factoryAdapters: ADAPTERS,
  factoryTokens: TOKENS,
  factoryPriceSources: PRICE_SOURCES,
  factoryLotteryPot: POT,
  implementationFactory: FACTORY,
  implementationAdapters: ADAPTERS,
  implementationTokens: TOKENS,
  implementationPriceSources: PRICE_SOURCES,
  implementationLotteryPot: POT,
  stack: {
    implementationZaps: ZAPS,
    implementationZapsAdapter: ZAPS_ADAPTER,
    zapsCode: CODE,
    zapsAdapterCode: CODE,
    zapsAllowed: true,
    zapsAdapterAllowed: true,
  },
};

describe("automationFeeLineageKey", () => {
  it("normalizes address casing without weakening exact lineage identity", () => {
    expect(
      automationFeeLineageKey({
        ...FEE_LINEAGE,
        factory: FEE_LINEAGE.factory.toLowerCase() as `0x${string}`,
      }),
    ).toBe(automationFeeLineageKey(FEE_LINEAGE));
  });

  it.each([
    ["intentKind", "trigger"],
    ["factory", address("a")],
    ["implementation", address("b")],
    ["priceSourceRegistry", address("c")],
    ["lotteryPot", address("d")],
    ["activePriceSource", address("e")],
    ["creationGateway", address("f")],
    ["creationPot", address("0")],
  ] satisfies Array<[keyof AutomationFeeLineage, string]>)(
    "invalidates a proof when %s changes",
    (field, value) => {
      expect(
        automationFeeLineageKey({ ...FEE_LINEAGE, [field]: value }),
      ).not.toBe(automationFeeLineageKey(FEE_LINEAGE));
    },
  );
});

describe("matchesAutomationFactoryProvenance", () => {
  it("accepts the exact pinned factory, implementation, and v3.2 bindings", () => {
    expect(matchesAutomationFactoryProvenance(EXPECTED, READBACK)).toBe(true);
  });

  it.each([
    ["factoryCode", { factoryCode: "0x" as Hex }],
    ["implementationCode", { implementationCode: "0x" as Hex }],
    ["adapterRegistryCode", { adapterRegistryCode: null }],
    ["tokenAllowlistCode", { tokenAllowlistCode: null }],
    ["priceSourceRegistryCode", { priceSourceRegistryCode: null }],
    ["lotteryPotCode", { lotteryPotCode: null }],
    ["activePriceSourceCode", { activePriceSourceCode: null }],
    ["activePriceSourceAllowed", { activePriceSourceAllowed: false }],
    ["factoryImplementation", { factoryImplementation: OTHER }],
    ["factoryImplementationHash", { factoryImplementationHash: `0x${"12".repeat(32)}` }],
    ["factoryVersion", { factoryVersion: "3.2.0-lookalike" }],
    ["factoryAdapters", { factoryAdapters: OTHER }],
    ["factoryTokens", { factoryTokens: OTHER }],
    ["factoryPriceSources", { factoryPriceSources: OTHER }],
    ["factoryLotteryPot", { factoryLotteryPot: OTHER }],
    ["implementationFactory", { implementationFactory: OTHER }],
    ["implementationAdapters", { implementationAdapters: OTHER }],
    ["implementationTokens", { implementationTokens: OTHER }],
    ["implementationPriceSources", { implementationPriceSources: OTHER }],
    ["implementationLotteryPot", { implementationLotteryPot: OTHER }],
  ] satisfies Array<[string, Partial<AutomationFactoryProvenanceReadback>]>)(
    "rejects a mutated %s readback",
    (_field, mutation) => {
      expect(matchesAutomationFactoryProvenance(EXPECTED, { ...READBACK, ...mutation })).toBe(false);
    },
  );

  it.each([
    ["implementationZaps", { implementationZaps: OTHER }],
    ["implementationZapsAdapter", { implementationZapsAdapter: OTHER }],
    ["zapsCode", { zapsCode: null }],
    ["zapsAdapterCode", { zapsAdapterCode: null }],
    ["zapsAllowed", { zapsAllowed: false }],
    ["zapsAdapterAllowed", { zapsAdapterAllowed: false }],
  ] satisfies Array<
    [string, Partial<NonNullable<AutomationFactoryProvenanceReadback["stack"]>>]
  >)(
    "rejects a mutated stack %s readback",
    (_field, mutation) => {
      expect(
        matchesAutomationFactoryProvenance(EXPECTED, {
          ...READBACK,
          stack: { ...READBACK.stack!, ...mutation },
        }),
      ).toBe(false);
    },
  );

  it("requires stack expectations and readback to be present or absent together", () => {
    expect(matchesAutomationFactoryProvenance({ ...EXPECTED, stack: null }, READBACK)).toBe(false);
    expect(matchesAutomationFactoryProvenance(EXPECTED, { ...READBACK, stack: null })).toBe(false);
    expect(
      matchesAutomationFactoryProvenance(
        { ...EXPECTED, stack: null },
        { ...READBACK, stack: null },
      ),
    ).toBe(true);
  });

  it("fails closed for malformed untyped data", () => {
    expect(
      matchesAutomationFactoryProvenance(
        EXPECTED,
        null as unknown as AutomationFactoryProvenanceReadback,
      ),
    ).toBe(false);
  });
});
