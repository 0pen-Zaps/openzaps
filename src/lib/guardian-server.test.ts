import { describe, expect, it } from "vitest";
import type { Hex, PublicClient } from "viem";

import {
  deriveGuardianSnapshot,
  guardianEnabled,
  mapGuardianPage,
  type GuardianBlockContext,
} from "@/lib/guardian-server";
import type { RelayRecord } from "@/lib/relay";
import type { ExecutionReceiptRecord } from "@/lib/receipt-server";

const RECORD: RelayRecord = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
  owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  chainId: 4663,
  kind: "recurring",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    seriesId: "1",
    validAfter: "0",
    deadline: "2000",
    interval: "100",
    maxRuns: "10",
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270",
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOutPerRun: "0",
  },
  signature: `0x${"ab".repeat(65)}` as Hex,
  status: "open",
  createdAt: "2026-07-28T00:00:00.000Z",
};

const TRIGGER_RECORD: RelayRecord = {
  ...RECORD,
  kind: "trigger",
  intent: {
    zap: RECORD.zap,
    chainId: "4663",
    nonce: "9",
    validAfter: "0",
    deadline: "2000",
    priceSource: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    baselinePriceX96: "100",
    thresholdBps: "20000",
    above: true,
    recipient: RECORD.owner,
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270",
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOut: "0",
  },
};

const CONTEXT: GuardianBlockContext = {
  blockNumber: 123n,
  timestamp: 1000n,
  latestBaseFeePerGas: 1n,
  pendingBaseFeePerGas: 1n,
};

function client({
  used = false,
  runs = 0,
  lastRun = 0,
  readError = null,
  simulationError = null,
  price = 0n,
  calls = [],
}: {
  used?: boolean;
  runs?: number;
  lastRun?: number;
  readError?: Error | null;
  simulationError?: Error | null;
  price?: bigint;
  calls?: Array<{ type: "read" | "simulate"; blockNumber: bigint | undefined }>;
} = {}): PublicClient {
  return {
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      calls.push({ type: "read", blockNumber });
      if (readError) throw readError;
      if (functionName === "nonceUsed") return used;
      if (functionName === "series") return [runs, lastRun];
      if (functionName === "priceX96") return price;
      return 0n;
    },
    simulateContract: async ({ blockNumber }: { blockNumber?: bigint }) => {
      calls.push({ type: "simulate", blockNumber });
      if (simulationError) throw simulationError;
      return { request: {} };
    },
  } as unknown as PublicClient;
}

const revertedReceipt = {
  outcome: "reverted",
  txHash: `0x${"12".repeat(32)}`,
} as ExecutionReceiptRecord;
const finalizedReceipt = {
  outcome: "finalized",
  txHash: `0x${"34".repeat(32)}`,
} as ExecutionReceiptRecord;

describe("guardian lifecycle derivation", () => {
  it("covers waiting and expired states without inventing receipt attribution", async () => {
    const waiting = await deriveGuardianSnapshot(
      client(),
      { ...RECORD, intent: { ...RECORD.intent, validAfter: "1100" } },
      CONTEXT,
      null,
    );
    expect(waiting.status).toBe("waiting");

    const expired = await deriveGuardianSnapshot(
      client(),
      { ...RECORD, intent: { ...RECORD.intent, deadline: "999" } },
      CONTEXT,
      null,
    );
    expect(expired.status).toBe("expired");

    const unknown = await deriveGuardianSnapshot(client({ used: true }), RECORD, CONTEXT, null);
    expect(unknown.status).toBe("consumed-unknown");
    expect(unknown.executionState).toBe("consumed-unknown");

    const finalized = await deriveGuardianSnapshot(client({ used: true }), TRIGGER_RECORD, CONTEXT, finalizedReceipt);
    expect(finalized.status).toBe("finalized");
  });

  it("does not misattribute an earlier recurring receipt as the later series revocation", async () => {
    const snapshot = await deriveGuardianSnapshot(
      client({ used: true, runs: 1, lastRun: 900 }),
      RECORD,
      CONTEXT,
      finalizedReceipt,
    );
    expect(snapshot.status).toBe("consumed-unknown");
    expect(snapshot.executionState).toBe("consumed-unknown");
    expect(snapshot.runs).toBe(1);
    expect(snapshot.detail).toContain("invalidated onchain after 1/10 runs");
    expect(snapshot.detail).not.toContain(finalizedReceipt.txHash);
  });

  it("distinguishes exhausted recurring series from early invalidation", async () => {
    const snapshot = await deriveGuardianSnapshot(
      client({ used: true, runs: 10, lastRun: 900 }),
      RECORD,
      CONTEXT,
      finalizedReceipt,
    );
    expect(snapshot.status).toBe("finalized");
    expect(snapshot.runs).toBe(10);
    expect(snapshot.detail).toBe("all 10 authorized runs are finalized");
  });

  it("reports due only after the exact signed call simulates successfully", async () => {
    const snapshot = await deriveGuardianSnapshot(client(), RECORD, CONTEXT, null);
    expect(snapshot.status).toBe("due");
    expect(snapshot.authorityScope).toBe("none");
  });

  it("distinguishes underfunding from a generic fail-closed blocker", async () => {
    const underfundedError = Object.assign(new Error("empty"), { errorName: "ZeroBalanceRelativeStep" });
    const underfunded = await deriveGuardianSnapshot(
      client({ simulationError: underfundedError }),
      RECORD,
      CONTEXT,
      null,
    );
    expect(underfunded.status).toBe("underfunded");

    const blocked = await deriveGuardianSnapshot(
      client({ readError: new Error("RPC unavailable") }),
      RECORD,
      CONTEXT,
      null,
    );
    expect(blocked.status).toBe("blocked");
  });

  it("surfaces a verified reverted attempt while the authorization remains live", async () => {
    const snapshot = await deriveGuardianSnapshot(
      client({ simulationError: new Error("MinOutNotMet") }),
      RECORD,
      CONTEXT,
      revertedReceipt,
    );
    expect(snapshot.status).toBe("reverted");
    expect(snapshot.executionState).toBe("reverted");
  });

  it("mirrors asymmetric contract threshold bounds above 100 percent", async () => {
    const above = await deriveGuardianSnapshot(client({ price: 300n }), TRIGGER_RECORD, CONTEXT, null);
    expect(above.status).toBe("due");

    const invalidBelow = await deriveGuardianSnapshot(
      client({ price: 0n }),
      {
        ...TRIGGER_RECORD,
        intent: { ...TRIGGER_RECORD.intent, above: false, thresholdBps: "10000" },
      },
      CONTEXT,
      null,
    );
    expect(invalidBelow.status).toBe("blocked");
  });

  it("pins every contract read and simulation to the captured latest block", async () => {
    const calls: Array<{ type: "read" | "simulate"; blockNumber: bigint | undefined }> = [];
    await deriveGuardianSnapshot(client({ calls }), RECORD, CONTEXT, null);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.blockNumber === CONTEXT.blockNumber)).toBe(true);
  });

  it("blocks a due authorization when latest or pending base fee exceeds its signed cap", async () => {
    const snapshot = await deriveGuardianSnapshot(
      client(),
      { ...RECORD, intent: { ...RECORD.intent, maxFeePerGas: "10" } },
      { ...CONTEXT, latestBaseFeePerGas: 5n, pendingBaseFeePerGas: 11n },
      null,
    );
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.detail).toContain("pending base fee 11");
  });
});

describe("guardian resource gates", () => {
  it("defaults off in production until both feature and durable quota gates are explicit", () => {
    expect(guardianEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      guardianEnabled({
        NODE_ENV: "production",
        OPENZAPS_GUARDIAN_ENABLED: "true",
        OPENZAPS_GUARDIAN_DURABLE_QUOTA_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      guardianEnabled({
        NODE_ENV: "production",
        OPENZAPS_GUARDIAN_ENABLED: "true",
        OPENZAPS_GUARDIAN_DURABLE_QUOTA_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("bounds concurrent page derivations and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapGuardianPage([30, 5, 20, 1], 2, async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });
});
