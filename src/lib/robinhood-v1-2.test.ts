import { getAddress, zeroAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const V1_2_ENV = {
  implementation: "NEXT_PUBLIC_OPENZAP_V1_2_IMPLEMENTATION",
  factory: "NEXT_PUBLIC_OPENZAP_V1_2_FACTORY",
  creationGateway: "NEXT_PUBLIC_OPENZAP_V1_2_CREATION_GATEWAY",
  creationFeePot: "NEXT_PUBLIC_OPENZAP_V1_2_CREATION_FEE_POT",
} as const;

const V1_2_ADDRESSES = {
  implementation: getAddress("0x1111111111111111111111111111111111111111"),
  factory: getAddress("0x2222222222222222222222222222222222222222"),
  creationGateway: getAddress("0x3333333333333333333333333333333333333333"),
  creationFeePot: getAddress("0x4444444444444444444444444444444444444444"),
} as const;

async function loadWithV1_2(
  values: Partial<Record<keyof typeof V1_2_ENV, string>> = {},
) {
  vi.resetModules();
  for (const [role, envName] of Object.entries(V1_2_ENV) as Array<
    [keyof typeof V1_2_ENV, string]
  >) {
    vi.stubEnv(envName, values[role] ?? "");
  }
  return import("@/lib/robinhood");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("v1.2 release configuration", () => {
  it("defaults every unpublished address to zero", async () => {
    const config = await loadWithV1_2();

    expect(config.OPENZAP_V1_2_CONTRACTS).toEqual({
      implementation: zeroAddress,
      factory: zeroAddress,
      creationGateway: zeroAddress,
      creationFeePot: zeroAddress,
    });
    expect(config.optionalContractSetState(config.OPENZAP_V1_2_CONTRACTS)).toBe(
      "absent",
    );
    expect(config.openZapV1_2Configured()).toBe(false);
    expect(
      config.configuredCapsuleLineages().map((lineage) => lineage.id),
    ).not.toContain("v1.2");
  });

  it("rejects a partial v1.2 release instead of scanning a fabricated subset", async () => {
    const config = await loadWithV1_2({
      factory: V1_2_ADDRESSES.factory,
    });

    expect(config.optionalContractSetState(config.OPENZAP_V1_2_CONTRACTS)).toBe(
      "partial",
    );
    expect(config.openZapV1_2Configured()).toBe(false);
    expect(() => config.configuredCapsuleLineages()).toThrow(/all-or-nothing/);
  });

  it("registers a complete v1.2 one-shot lineage without adding an execution pot", async () => {
    const config = await loadWithV1_2(V1_2_ADDRESSES);
    const lineages = config.configuredCapsuleLineages();
    const v1_2 = lineages.find((lineage) => lineage.id === "v1.2");

    expect(config.openZapV1_2Configured()).toBe(true);
    expect(v1_2).toEqual({
      id: "v1.2",
      factory: V1_2_ADDRESSES.factory,
      implementation: V1_2_ADDRESSES.implementation,
      lotteryPot: null,
      creationGateway: V1_2_ADDRESSES.creationGateway,
      creationFeePot: V1_2_ADDRESSES.creationFeePot,
    });
    expect(config.configuredCapsuleFactories()).toContain(
      V1_2_ADDRESSES.factory,
    );
    expect(config.configuredExecutionPots()).not.toContainEqual(
      expect.objectContaining({ address: V1_2_ADDRESSES.creationFeePot }),
    );

    const profile = await import("@/lib/profile");
    expect(profile.lineageForFactory(V1_2_ADDRESSES.factory)).toBe("v1.2");
    expect(profile.isStandingIntentLineage("v1.2")).toBe(false);
  });

  it("rejects a v1.2 role that aliases an existing lineage identity", async () => {
    const config = await loadWithV1_2({
      ...V1_2_ADDRESSES,
      factory: "0xFC775017b25d2458623E2f3E735A4B750dD8b4E4",
    });

    expect(config.openZapV1_2Configured()).toBe(true);
    expect(() => config.configuredCapsuleLineages()).toThrow(
      /duplicates v1\.1 factory/,
    );
  });
});

describe("v1.2 contract ABIs", () => {
  it("exports the exact factory, gateway, capsule, and Permit2 calls the app uses", async () => {
    const config = await loadWithV1_2();
    const names = (abi: readonly { name?: string }[]) =>
      abi.flatMap((item) => item.name ?? []);

    expect(names(config.openZapV1_2FactoryAbi)).toEqual(
      expect.arrayContaining([
        "implementation",
        "implCodeHash",
        "VERSION",
        "adapters",
        "tokens",
        "createZap",
        "predict",
        "ZapCreated",
      ]),
    );
    expect(names(config.openZapV1_2CreationGatewayAbi)).toEqual(
      expect.arrayContaining([
        "V1_2_FACTORY",
        "CREATION_POT",
        "CREATION_FEE",
        "createZap",
        "predict",
        "V1_2CreationFeeConverted",
      ]),
    );
    expect(names(config.openZapV1_2Abi)).toEqual(
      expect.arrayContaining([
        "FACTORY",
        "PERMIT2",
        "PERMIT2_MAX_DEADLINE_WINDOW",
        "policyHalted",
        "executeWithPermit2",
        "haltPolicy",
        "PolicyHalted",
      ]),
    );
    expect(names(config.permit2NonceBitmapAbi)).toEqual([
      "nonceBitmap",
      "invalidateUnorderedNonces",
    ]);
  });

  it("pins the nested executeWithPermit2 tuple and indexed halt event", async () => {
    const config = await loadWithV1_2();
    const execute = config.openZapV1_2Abi.find(
      (item) => item.type === "function" && item.name === "executeWithPermit2",
    );
    const halted = config.openZapV1_2Abi.find(
      (item) => item.type === "event" && item.name === "PolicyHalted",
    );

    expect(execute).toMatchObject({
      stateMutability: "nonpayable",
      inputs: [
        { name: "intent", type: "tuple" },
        {
          name: "permit",
          type: "tuple",
          components: [
            {
              name: "permitted",
              type: "tuple",
              components: [
                { name: "token", type: "address" },
                { name: "amount", type: "uint256" },
              ],
            },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { name: "intentSig", type: "bytes" },
        { name: "permitSig", type: "bytes" },
      ],
    });
    expect(halted).toMatchObject({
      inputs: [
        { name: "owner", type: "address", indexed: true },
        { name: "policyHash", type: "bytes32", indexed: true },
      ],
    });
  });
});
