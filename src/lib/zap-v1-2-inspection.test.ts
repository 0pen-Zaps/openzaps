import {
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

type RobinhoodModule = typeof import("@/lib/robinhood");
type OpenZapModule = typeof import("@/lib/openzap");
type Policy = ReturnType<OpenZapModule["buildRobinhoodPolicy"]>;

const PINNED_BLOCK = 12_345n;
const PINNED_TIMESTAMP = 1_800_000_000n;
const OWNER = getAddress("0x5a52D4B820Ae7F02880d270562950918ACb14aA2");
const OTHER = getAddress("0x9999999999999999999999999999999999999999");
const ZAP = getAddress("0x7777777777777777777777777777777777777777");
const IMPLEMENTATION_CODE = "0x6001600055" as Hex;
const CONTRACT_CODE = "0x60006000" as Hex;
const AMOUNT_IN = 10n ** 18n;

const V1_2_ENV = {
  NEXT_PUBLIC_OPENZAP_V1_2_IMPLEMENTATION: getAddress(
    "0x1111111111111111111111111111111111111111",
  ),
  NEXT_PUBLIC_OPENZAP_V1_2_FACTORY: getAddress(
    "0x2222222222222222222222222222222222222222",
  ),
  NEXT_PUBLIC_OPENZAP_V1_2_CREATION_GATEWAY: getAddress(
    "0x3333333333333333333333333333333333333333",
  ),
  NEXT_PUBLIC_OPENZAP_V1_2_CREATION_FEE_POT: getAddress(
    "0x4444444444444444444444444444444444444444",
  ),
} as const;

async function loadModules(v1_2: "absent" | "configured") {
  vi.resetModules();
  for (const [name, address] of Object.entries(V1_2_ENV)) {
    vi.stubEnv(name, v1_2 === "configured" ? address : "");
  }
  const config = await import("@/lib/robinhood");
  const openzap = await import("@/lib/openzap");
  const zap = await import("@/lib/zap");
  return { config, openzap, zap };
}

type ChainCall = {
  kind: "getBlockNumber" | "getBlock" | "getBytecode" | "readContract";
  address?: Address;
  functionName?: string;
  blockNumber?: bigint;
};

type ClientOverrides = {
  lineage: "v1.1" | "v1.2";
  runtimeImplementation?: Address;
  factoryVersion?: string;
  factoryImplementation?: Address;
  committedImplementationHash?: Hex;
  adapterRegistry?: Address;
  tokenAllowlist?: Address;
  cloneFactory?: Address;
  permit2?: Address;
  permit2Code?: Hex | null;
  permit2DeadlineWindow?: bigint;
  policyHalted?: boolean;
  owner?: Address;
  recipient?: Address;
  policy?: Policy;
  policyHash?: Hex;
};

function fakeClient(
  config: RobinhoodModule,
  openzap: OpenZapModule,
  overrides: ClientOverrides,
): { client: PublicClient; calls: ChainCall[]; policy: Policy } {
  const calls: ChainCall[] = [];
  const lineage =
    overrides.lineage === "v1.2"
      ? config.OPENZAP_V1_2_CONTRACTS
      : config.OPENZAP_CONTRACTS;
  const expectedVersion =
    overrides.lineage === "v1.2"
      ? config.OPENZAP_V1_2_FACTORY_VERSION
      : config.OPENZAP_V1_1_FACTORY_VERSION;
  const policy =
    overrides.policy ?? openzap.buildRobinhoodPolicy(OWNER, "buy", AMOUNT_IN);
  const policyHash =
    overrides.policyHash ?? openzap.hashRobinhoodPolicy(policy);
  const runtimeImplementation =
    overrides.runtimeImplementation ?? lineage.implementation;

  const client = {
    async getBlockNumber(args: { cacheTime?: number }) {
      calls.push({ kind: "getBlockNumber" });
      expect(args.cacheTime).toBe(0);
      return PINNED_BLOCK;
    },
    async getBlock(args: { blockNumber: bigint }) {
      calls.push({ kind: "getBlock", blockNumber: args.blockNumber });
      return { timestamp: PINNED_TIMESTAMP };
    },
    async getBytecode(args: { address: Address; blockNumber?: bigint }) {
      calls.push({ kind: "getBytecode", ...args });
      if (same(args.address, ZAP)) {
        return openzap.expectedCloneRuntime(runtimeImplementation);
      }
      if (same(args.address, lineage.implementation))
        return IMPLEMENTATION_CODE;
      if (same(args.address, config.ROBINHOOD_LIQUIDITY.permit2))
        return overrides.permit2Code === undefined
          ? CONTRACT_CODE
          : overrides.permit2Code;
      return CONTRACT_CODE;
    },
    async readContract(args: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) {
      calls.push({
        kind: "readContract",
        address: args.address,
        functionName: args.functionName,
        blockNumber: args.blockNumber,
      });

      if (same(args.address, lineage.factory)) {
        switch (args.functionName) {
          case "implementation":
            return overrides.factoryImplementation ?? lineage.implementation;
          case "implCodeHash":
            return (
              overrides.committedImplementationHash ??
              keccak256(IMPLEMENTATION_CODE)
            );
          case "VERSION":
            return overrides.factoryVersion ?? expectedVersion;
          case "adapters":
            return (
              overrides.adapterRegistry ??
              config.OPENZAP_CONTRACTS.adapterRegistry
            );
          case "tokens":
            return (
              overrides.tokenAllowlist ??
              config.OPENZAP_CONTRACTS.tokenAllowlist
            );
          default:
            throw new Error(`Unexpected factory read ${args.functionName}`);
        }
      }

      if (same(args.address, ZAP)) {
        switch (args.functionName) {
          case "owner":
            return overrides.owner ?? OWNER;
          case "recipient":
            return overrides.recipient ?? OWNER;
          case "maxRelayerFeeCap":
            return policy.maxRelayerFeeCap;
          case "optimization":
            return policy.optimization;
          case "trackedAssets":
            return policy.trackedAssets;
          case "stepCount":
            return BigInt(policy.steps.length);
          case "policyHash":
            return policyHash;
          case "step":
            return policy.steps[Number(args.args?.[0] ?? 0n)];
          case "FACTORY":
            return overrides.cloneFactory ?? lineage.factory;
          case "PERMIT2":
            return overrides.permit2 ?? config.ROBINHOOD_LIQUIDITY.permit2;
          case "PERMIT2_MAX_DEADLINE_WINDOW":
            return overrides.permit2DeadlineWindow ?? 3_600n;
          case "policyHalted":
            return overrides.policyHalted ?? false;
          default:
            throw new Error(`Unexpected capsule read ${args.functionName}`);
        }
      }

      if (args.functionName === "isAllowed") return true;
      throw new Error(
        `Unexpected read ${args.functionName} at ${args.address}`,
      );
    },
  } as unknown as PublicClient;

  return { client, calls, policy };
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function expectPinned(calls: readonly ChainCall[]): void {
  for (const call of calls) {
    if (call.kind !== "getBlockNumber") {
      expect(
        call.blockNumber,
        `${call.kind}:${call.functionName ?? call.address}`,
      ).toBe(PINNED_BLOCK);
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("inspectOwnedLiveZap lineage verification", () => {
  it("keeps the deployed v1.1 path compatible and never probes v1.2-only selectors", async () => {
    const { config, openzap, zap } = await loadModules("absent");
    const { client, calls } = fakeClient(config, openzap, { lineage: "v1.1" });

    const verified = await zap.inspectOwnedLiveZap(client, ZAP, OWNER);

    expect(verified).toMatchObject({
      address: ZAP,
      lineage: "v1.1",
      policyHalted: false,
      blockNumber: PINNED_BLOCK,
      blockTimestamp: PINNED_TIMESTAMP,
    });
    expect(calls.map((call) => call.functionName).filter(Boolean)).not.toEqual(
      expect.arrayContaining(["FACTORY", "PERMIT2", "policyHalted"]),
    );
    expectPinned(calls);
  });

  it("detects a fully configured v1.2 clone and returns its one-way halt state", async () => {
    const { config, openzap, zap } = await loadModules("configured");
    const { client, calls } = fakeClient(config, openzap, {
      lineage: "v1.2",
      policyHalted: true,
    });

    const verified = await zap.inspectOwnedLiveZap(client, ZAP, OWNER);

    expect(verified).toMatchObject({
      address: ZAP,
      lineage: "v1.2",
      policyHalted: true,
      blockNumber: PINNED_BLOCK,
      blockTimestamp: PINNED_TIMESTAMP,
    });
    expect(calls.map((call) => call.functionName)).toEqual(
      expect.arrayContaining([
        "VERSION",
        "FACTORY",
        "PERMIT2",
        "PERMIT2_MAX_DEADLINE_WINDOW",
        "policyHalted",
      ]),
    );
    expectPinned(calls);
  });

  it("rejects a clone runtime outside both configured one-shot implementations", async () => {
    const { config, openzap, zap } = await loadModules("configured");
    const { client, calls } = fakeClient(config, openzap, {
      lineage: "v1.2",
      runtimeImplementation: OTHER,
    });

    await expect(zap.inspectOwnedLiveZap(client, ZAP, OWNER)).rejects.toThrow(
      "not a canonical clone of a configured one-shot",
    );
    expect(calls.filter((call) => call.functionName)).toHaveLength(0);
    expectPinned(calls);
  });

  it("fails closed on every v1.2 factory, registry, and immutable-capsule mismatch", async () => {
    const { config, openzap, zap } = await loadModules("configured");
    const cases: Array<{
      overrides: Omit<ClientOverrides, "lineage">;
      message: string;
    }> = [
      {
        overrides: { factoryVersion: "1.2.0-lookalike" },
        message: "factory VERSION",
      },
      {
        overrides: { factoryImplementation: OTHER },
        message: "factory's code commitment",
      },
      {
        overrides: { committedImplementationHash: `0x${"12".repeat(32)}` },
        message: "factory's code commitment",
      },
      {
        overrides: { adapterRegistry: OTHER },
        message: "shared adapter and token registries",
      },
      {
        overrides: { tokenAllowlist: OTHER },
        message: "shared adapter and token registries",
      },
      {
        overrides: { cloneFactory: OTHER },
        message: "does not pin the configured v1.2 factory",
      },
      {
        overrides: { permit2: OTHER },
        message: "does not pin canonical Permit2",
      },
      {
        overrides: { permit2DeadlineWindow: 3_601n },
        message: "does not pin the one-hour Permit2 deadline window",
      },
      {
        overrides: { permit2Code: null },
        message: "Canonical Permit2 has no code",
      },
    ];

    for (const testCase of cases) {
      const { client } = fakeClient(config, openzap, {
        lineage: "v1.2",
        ...testCase.overrides,
      });
      await expect(zap.inspectOwnedLiveZap(client, ZAP, OWNER)).rejects.toThrow(
        testCase.message,
      );
    }
  });

  it("verifies owner, committed policy hash, and supported ordered route", async () => {
    const { config, openzap, zap } = await loadModules("configured");
    const wrongOwner = fakeClient(config, openzap, {
      lineage: "v1.2",
      owner: OTHER,
    });
    await expect(
      zap.inspectOwnedLiveZap(wrongOwner.client, ZAP, OWNER),
    ).rejects.toThrow("owner and recipient must match");

    const wrongHash = fakeClient(config, openzap, {
      lineage: "v1.2",
      policyHash: `0x${"34".repeat(32)}`,
    });
    await expect(
      zap.inspectOwnedLiveZap(wrongHash.client, ZAP, OWNER),
    ).rejects.toThrow("policy hash does not match");

    const canonical = openzap.buildRobinhoodPolicy(OWNER, "buy", AMOUNT_IN);
    const offRoute: Policy = {
      ...canonical,
      steps: [
        {
          ...canonical.steps[0],
          adapter: OTHER,
          spender: OTHER,
        },
      ],
    };
    const wrongRoute = fakeClient(config, openzap, {
      lineage: "v1.2",
      policy: offRoute,
    });
    await expect(
      zap.inspectOwnedLiveZap(wrongRoute.client, ZAP, OWNER),
    ).rejects.toThrow("outside the supported ordered v1.2 route manifest");
  });
});
