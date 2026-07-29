import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const IMPLEMENTATION = "0x1212121212121212121212121212121212121212";
const FACTORY = "0x1313131313131313131313131313131313131313";
const GATEWAY = "0x1414141414141414141414141414141414141414";
const POT = "0x1515151515151515151515151515151515151515";
const ZAP = "0x1616161616161616161616161616161616161616";
const OWNER = "0x1717171717171717171717171717171717171717";
const POLICY = `0x${"ab".repeat(32)}` as `0x${string}`;
const TX = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_V1_2_IMPLEMENTATION", IMPLEMENTATION);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_V1_2_FACTORY", FACTORY);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_V1_2_CREATION_GATEWAY", GATEWAY);
  vi.stubEnv("NEXT_PUBLIC_OPENZAP_V1_2_CREATION_FEE_POT", POT);
  vi.resetModules();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("canonical PolicyHalted ingestion", () => {
  it("adds the exact v1.2 event to protocol activity and stats", async () => {
    const { aggregateActivity } = await import("@/lib/activity");
    const result = aggregateActivity(
      [{
        zap: ZAP,
        owner: OWNER,
        factory: FACTORY,
        policyHash: POLICY,
        txHash: TX(1),
        blockNumber: 100n,
        logIndex: 0,
      }],
      [],
      [],
      [],
      new Map([[200n, 1_785_200_000]]),
      "2026-07-29T00:00:00.000Z",
      [{
        emitter: ZAP,
        owner: OWNER,
        policyHash: POLICY,
        txHash: TX(2),
        blockNumber: 200n,
        logIndex: 1,
      }],
    );

    expect(result.stats.policiesHalted).toBe(1);
    expect(result.activity[0]).toMatchObject({
      type: "halted",
      zap: ZAP,
      actor: OWNER,
      detail: "execution policy permanently halted",
      timestamp: 1_785_200_000,
    });
  });

  it("projects the pinned v1.2 bit and exact event into a wallet profile", async () => {
    const { aggregateWalletProfile } = await import("@/lib/profile");
    const result = aggregateWalletProfile({
      owner: OWNER,
      created: [{
        zap: ZAP,
        owner: OWNER,
        factory: FACTORY,
        policyHash: POLICY,
        txHash: TX(1),
        blockNumber: 100n,
        logIndex: 0,
      }],
      executed: [],
      automated: [],
      exits: [],
      invalidated: [],
      finished: [],
      halted: [{
        emitter: ZAP,
        owner: OWNER,
        policyHash: POLICY,
        txHash: TX(2),
        blockNumber: 200n,
        logIndex: 1,
      }],
      zapReads: [{
        zap: ZAP,
        trackedAssets: [],
        policyHalted: true,
      }],
      timestamps: new Map([[200n, 1_785_200_000]]),
      fromBlock: 90n,
      headBlock: 250n,
      updatedAt: "2026-07-29T00:00:00.000Z",
    });

    expect(result.sourceStatus).toBe("live");
    expect(result.stats.policiesHalted).toBe(1);
    expect(result.zaps[0]).toMatchObject({
      lineage: "v1.2",
      policyHaltStatus: "halted",
      policyHalted: true,
      haltedAt: 1_785_200_000,
      haltedTx: TX(2),
    });
    expect(result.activity[0].kind).toBe("halted");
  });

  it("keeps the pinned bit and event provenance together on capsule detail", async () => {
    const [{ buildRobinhoodPolicy, expectedCloneRuntime, hashRobinhoodPolicy }, { aggregateZapDetail }] =
      await Promise.all([import("@/lib/openzap"), import("@/lib/zap")]);
    const policy = buildRobinhoodPolicy(OWNER, "buy", 10n ** 18n);
    const policyHash = hashRobinhoodPolicy(policy);
    const result = aggregateZapDetail({
      address: ZAP,
      created: {
        zap: ZAP,
        owner: OWNER,
        factory: FACTORY,
        policyHash,
        implCodeHash: `0x${"cd".repeat(32)}`,
        salt: `0x${"ef".repeat(32)}`,
        txHash: TX(1),
        blockNumber: 100n,
        logIndex: 0,
      },
      policy: {
        ...policy,
        stepCount: BigInt(policy.steps.length),
        policyHash,
      },
      factory: { version: "1.2.0-candidate", implementation: IMPLEMENTATION },
      runtime: expectedCloneRuntime(IMPLEMENTATION),
      balances: { weth: 0n, zaps: 0n, native: 0n },
      executed: [],
      automated: [],
      exits: [],
      policyHalted: true,
      halted: [{
        emitter: ZAP,
        owner: OWNER,
        policyHash,
        txHash: TX(2),
        blockNumber: 200n,
        logIndex: 1,
      }],
      timestamps: new Map([[200n, 1_785_200_000]]),
      headBlock: 250n,
      readAt: "2026-07-29T00:00:00.000Z",
    });

    expect(result.lineage).toBe("v1.2");
    expect(result.policyHalt).toEqual({
      status: "halted",
      policyHalted: true,
      haltedAt: 1_785_200_000,
      haltedBlock: "200",
      haltedTx: TX(2),
    });
  });
});
