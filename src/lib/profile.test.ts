import { describe, expect, it } from "vitest";

import type {
  AutomatedRunLogInput,
  ExecutedLogInput,
  ExitLogInput,
  PolicyHaltedLogInput,
} from "@/lib/activity";
import {
  aggregateWalletProfile,
  isStandingIntentLineage,
  lineageForFactory,
  type NonceInvalidatedLogInput,
  type SeriesFinishedLogInput,
  type WalletCreationLogInput,
} from "@/lib/profile";
import {
  OPENZAP_CONTRACTS,
  OPENZAP_V3_CONTRACTS,
  OPENZAP_V3_1_CONTRACTS,
  OPENZAP_V3_2_CONTRACTS,
  ROBINHOOD_ASSETS,
} from "@/lib/robinhood";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const EXECUTOR = "0x3333333333333333333333333333333333333333" as const;
const ZAP = "0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4" as const;
const OTHER_ZAP = "0x4444444444444444444444444444444444444444" as const;
const SPOOFER = "0x9999999999999999999999999999999999999999" as const;
const POLICY = `0x${"ab".repeat(32)}` as const;
const tx = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

function creation(overrides: Partial<WalletCreationLogInput> = {}): WalletCreationLogInput {
  return {
    zap: ZAP,
    owner: OWNER,
    factory: OPENZAP_V3_1_CONTRACTS.factory,
    policyHash: POLICY,
    txHash: tx(1),
    blockNumber: 100n,
    logIndex: 0,
    ...overrides,
  };
}

function execution(overrides: Partial<ExecutedLogInput> = {}): ExecutedLogInput {
  return {
    emitter: ZAP,
    recipient: OWNER,
    outAsset: ROBINHOOD_ASSETS.zaps,
    amountOut: 5n,
    txHash: tx(2),
    blockNumber: 200n,
    logIndex: 1,
    ...overrides,
  };
}

function automation(overrides: Partial<AutomatedRunLogInput> = {}): AutomatedRunLogInput {
  return {
    emitter: ZAP,
    kind: "recurring-relative",
    executor: EXECUTOR,
    outAsset: ROBINHOOD_ASSETS.zaps,
    amountOut: 7n,
    executorFee: 1n,
    potFee: 1n,
    stackIn: null,
    zapsOut: null,
    seriesId: 42n,
    run: 1,
    txHash: tx(3),
    blockNumber: 300n,
    logIndex: 2,
    ...overrides,
  };
}

function recovery(overrides: Partial<ExitLogInput> = {}): ExitLogInput {
  return {
    emitter: ZAP,
    owner: OWNER,
    asset: ROBINHOOD_ASSETS.weth,
    amount: 11n,
    txHash: tx(4),
    blockNumber: 400n,
    logIndex: 3,
    ...overrides,
  };
}

function revoked(overrides: Partial<NonceInvalidatedLogInput> = {}): NonceInvalidatedLogInput {
  return {
    emitter: ZAP,
    nonce: 42n,
    txHash: tx(5),
    blockNumber: 500n,
    logIndex: 4,
    ...overrides,
  };
}

function finished(overrides: Partial<SeriesFinishedLogInput> = {}): SeriesFinishedLogInput {
  return {
    emitter: ZAP,
    seriesId: 42n,
    runs: 10,
    txHash: tx(6),
    blockNumber: 600n,
    logIndex: 5,
    ...overrides,
  };
}

function halted(overrides: Partial<PolicyHaltedLogInput> = {}): PolicyHaltedLogInput {
  return {
    emitter: ZAP,
    owner: OWNER,
    policyHash: POLICY,
    txHash: tx(7),
    blockNumber: 650n,
    logIndex: 6,
    ...overrides,
  };
}

function aggregate(overrides: Partial<Parameters<typeof aggregateWalletProfile>[0]> = {}) {
  return aggregateWalletProfile({
    owner: OWNER,
    created: [creation()],
    executed: [execution()],
    automated: [automation()],
    exits: [recovery()],
    invalidated: [revoked()],
    finished: [finished()],
    halted: [],
    zapReads: [{
      zap: ZAP,
      trackedAssets: [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps],
      policyHalted: null,
    }],
    timestamps: new Map([[600n, 1_700_000_600]]),
    fromBlock: 90n,
    headBlock: 700n,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  });
}

describe("aggregateWalletProfile", () => {
  it("merges every confirmed lifecycle event into one newest-first wallet history", () => {
    const profile = aggregate();
    expect(profile.activity.map((row) => row.kind)).toEqual([
      "series-finished",
      "revoked",
      "recovered",
      "automated",
      "executed",
      "created",
    ]);
    expect(profile.activity[0].timestamp).toBe(1_700_000_600);
    expect(profile.stats).toMatchObject({
      zapsCreated: 1,
      oneShotExecutions: 1,
      automatedRuns: 1,
      recoveries: 1,
      authorizationsRevoked: 1,
    });
    expect(profile.stats.executedVolume["0xZAPS"]).toBe("12");
  });

  it("drops foreign-owner creations and spoofed capsule events before totals", () => {
    const profile = aggregate({
      created: [
        creation(),
        creation({ zap: OTHER_ZAP, owner: OTHER, txHash: tx(8) }),
      ],
      executed: [execution(), execution({ emitter: SPOOFER, amountOut: 999n, txHash: tx(9) })],
      invalidated: [revoked({ emitter: SPOOFER, txHash: tx(10) })],
    });
    expect(profile.stats.zapsCreated).toBe(1);
    expect(profile.stats.oneShotExecutions).toBe(1);
    expect(profile.stats.authorizationsRevoked).toBe(0);
    expect(profile.activity.every((row) => row.zap === ZAP)).toBe(true);
  });

  it("keeps management reads fail-closed without hiding proven history", () => {
    const profile = aggregate({
      zapReads: [{ zap: ZAP, trackedAssets: null, policyHalted: null }],
    });
    expect(profile.sourceStatus).toBe("degraded");
    expect(profile.zaps[0].managementReadsStatus).toBe("unavailable");
    expect(profile.zaps[0].trackedAssets).toBeNull();
    expect(profile.stats.zapsCreated).toBe(1);
  });

  it("distinguishes revocation from execution instead of inferring from nonceUsed", () => {
    const row = aggregate().activity.find((activity) => activity.kind === "revoked");
    expect(row?.authorizationId).toBe("42");
    expect(row?.detail).toBe("authorization revoked onchain");
    expect(row?.amount).toBeNull();
  });

  it("rejects a PolicyHalted-shaped log from unsupported v3.1", () => {
    const profile = aggregate({ halted: [halted()] });
    expect(profile.stats.policiesHalted).toBe(0);
    expect(profile.zaps[0].policyHaltStatus).toBe("unsupported");
    expect(profile.activity.some((row) => row.kind === "halted")).toBe(false);
  });
});

describe("lineageForFactory", () => {
  it("maps every canonical factory lineage", () => {
    expect(lineageForFactory(OPENZAP_CONTRACTS.factory)).toBe("v1.1");
    expect(lineageForFactory(OPENZAP_V3_CONTRACTS.factory)).toBe("v3");
    expect(lineageForFactory(OPENZAP_V3_1_CONTRACTS.factory)).toBe("v3.1");
    expect(lineageForFactory(OPENZAP_V3_2_CONTRACTS.factory)).toBe("v3.2");
    expect(lineageForFactory(OTHER)).toBe("unknown");
  });

  it("admits only exact standing-intent lineages to agent connection", () => {
    expect(isStandingIntentLineage("v3")).toBe(true);
    expect(isStandingIntentLineage("v3.1")).toBe(true);
    expect(isStandingIntentLineage("v3.2")).toBe(true);
    expect(isStandingIntentLineage("v1.1")).toBe(false);
    expect(isStandingIntentLineage("unknown")).toBe(false);
  });
});
