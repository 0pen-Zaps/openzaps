import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import type { RelayRecord } from "@/lib/relay";
import { ReceiptVerificationError } from "@/lib/receipt-server";

const guardianMocks = vi.hoisted(() => {
  const client = {
    getBlock: vi.fn(),
  };
  return {
    client,
    createOperationsPublicClient: vi.fn(() => client),
    deriveGuardianSnapshot: vi.fn(),
    guardianEnabled: vi.fn(),
  };
});
const receiptMocks = vi.hoisted(() => ({
  latestReceiptForIntent: vi.fn(),
}));
const relayMocks = vi.hoisted(() => ({
  listRelayIntentsPage: vi.fn(),
  relayConfigured: vi.fn(),
}));
const quotaMocks = vi.hoisted(() => ({
  serverRateLimit: vi.fn(),
}));

vi.mock("@/lib/guardian-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/guardian-server")>()),
  createOperationsPublicClient: guardianMocks.createOperationsPublicClient,
  deriveGuardianSnapshot: guardianMocks.deriveGuardianSnapshot,
  guardianEnabled: guardianMocks.guardianEnabled,
}));
vi.mock("@/lib/receipt-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt-server")>()),
  latestReceiptForIntent: receiptMocks.latestReceiptForIntent,
}));
vi.mock("@/lib/relay-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-server")>()),
  listRelayIntentsPage: relayMocks.listRelayIntentsPage,
  relayConfigured: relayMocks.relayConfigured,
}));
vi.mock("@/lib/relay-rate-limit", () => quotaMocks);

import { GET } from "@/app/api/guardian/route";

const RECORD: RelayRecord = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
  owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  chainId: 4663,
  kind: "trigger",
  intent: {
    zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
    chainId: "4663",
    nonce: "7",
    validAfter: "0",
    deadline: "2000",
    priceSource: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    baselinePriceX96: "1",
    thresholdBps: "1000",
    above: true,
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    executor: "0x0000000000000000000000000000000000000000",
    maxGas: "3000000",
    maxFeePerGas: "10000000000",
    policyHash: `0x${"34".repeat(32)}`,
    outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
    minOut: "0",
  },
  signature: `0x${"ab".repeat(65)}` as Hex,
  status: "open",
  createdAt: "2026-07-29T09:00:00.000Z",
};

const SNAPSHOT = {
  intentId: RECORD.id,
  zap: RECORD.zap,
  owner: RECORD.owner,
  kind: RECORD.kind,
  nonce: "7",
  executor: RECORD.intent.executor,
  status: "due",
  detail: "exact signed call simulates successfully",
  nextRunAt: null,
  runs: null,
  executionState: "none",
  latestReceipt: null,
  observedAt: "2026-07-29T09:00:00.000Z",
  authorityScope: "none",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  guardianMocks.guardianEnabled.mockReturnValue(true);
  relayMocks.relayConfigured.mockReturnValue(true);
  quotaMocks.serverRateLimit.mockReturnValue({
    limited: false,
    retryAfterSeconds: 0,
  });
  relayMocks.listRelayIntentsPage.mockResolvedValue({
    intents: [RECORD],
    nextCursor: null,
  });
  receiptMocks.latestReceiptForIntent.mockResolvedValue(null);
  guardianMocks.deriveGuardianSnapshot.mockResolvedValue(SNAPSHOT);
  guardianMocks.client.getBlock.mockImplementation(async ({ blockTag }: { blockTag: string }) => (
    blockTag === "latest"
      ? {
          number: 123n,
          timestamp: 1_785_312_000n,
          baseFeePerGas: 2n,
        }
      : {
          number: null,
          timestamp: 1_785_312_001n,
          baseFeePerGas: 3n,
        }
  ));
});

describe("Guardian route gates", () => {
  it("fails before storage or chain work when production admission is disabled", async () => {
    guardianMocks.guardianEnabled.mockReturnValue(false);
    const response = await GET(new NextRequest("https://0xzaps.com/api/guardian"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(relayMocks.listRelayIntentsPage).not.toHaveBeenCalled();
    expect(guardianMocks.client.getBlock).not.toHaveBeenCalled();
  });

  it("derives an enabled page from one captured block and bounded query", async () => {
    const response = await GET(new NextRequest(
      `https://0xzaps.com/api/guardian?limit=1&owner=${RECORD.owner}`,
      { headers: { "x-forwarded-for": "203.0.113.93" } },
    ));

    expect(response.status).toBe(200);
    expect(relayMocks.listRelayIntentsPage).toHaveBeenCalledWith({
      status: "open",
      owner: RECORD.owner,
      zap: null,
      executor: null,
      limit: 1,
      cursor: null,
    });
    expect(receiptMocks.latestReceiptForIntent).toHaveBeenCalledWith(RECORD.id, 123n);
    expect(guardianMocks.deriveGuardianSnapshot).toHaveBeenCalledWith(
      guardianMocks.client,
      RECORD,
      {
        blockNumber: 123n,
        timestamp: 1_785_312_000n,
        latestBaseFeePerGas: 2n,
        pendingBaseFeePerGas: 3n,
      },
      null,
    );
    expect(await response.json()).toEqual({
      chainId: 4663,
      snapshots: [SNAPSHOT],
      nextCursor: null,
      authorityScope: "none",
    });
  });

  it("fails closed before lifecycle derivation when stored verified provenance is malformed", async () => {
    receiptMocks.latestReceiptForIntent.mockRejectedValueOnce(
      new ReceiptVerificationError(
        "Stored verified receipt has malformed capsule provenance.",
        "storage",
      ),
    );

    const response = await GET(new NextRequest(
      "https://0xzaps.com/api/guardian?limit=1",
      { headers: { "x-forwarded-for": "203.0.113.94" } },
    ));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Guardian derivation failed.",
      snapshots: [],
    });
    expect(guardianMocks.deriveGuardianSnapshot).not.toHaveBeenCalled();
  });
});
