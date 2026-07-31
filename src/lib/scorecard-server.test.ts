import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildExecutorScorecard,
  decodeScorecardCursor,
  encodeScorecardCursor,
  executorScorecardPage,
  scorecardPageLimit,
  type ScorecardReceiptEvidence,
} from "@/lib/scorecard-server";

const EXECUTOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ASSET = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("executor scorecard", () => {
  it("aggregates only verified receipt evidence and never confers authority", () => {
    const receipts: ScorecardReceiptEvidence[] = [
      {
        outcome: "finalized",
        zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
        blockNumber: "10",
        txHash: `0x${"11".repeat(32)}`,
        gasUsed: "100",
        blockTime: "2026-07-28T00:00:00.000Z",
        eventPayload: { outAsset: ASSET, executorFee: "5" },
      },
      {
        outcome: "reverted",
        zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
        blockNumber: "11",
        txHash: `0x${"22".repeat(32)}`,
        gasUsed: "50",
        blockTime: "2026-07-28T00:01:00.000Z",
        eventPayload: {},
      },
    ];
    const scorecard = buildExecutorScorecard(EXECUTOR, receipts);
    expect(scorecard).toMatchObject({
      attempts: 2,
      finalized: 1,
      reverted: 1,
      reliabilityBps: 5_000,
      uniqueZaps: 1,
      totalGasUsed: "150",
      authorityScope: "none",
    });
    expect(scorecard.executorFeesByAsset[ASSET.toLowerCase()]).toBe("5");
  });

  it("bounds history with an opaque keyset cursor while totals come from one aggregate RPC", async () => {
    const rows = [10, 9, 8].map((block) => ({
      outcome: "finalized",
      zap: "0x9941dd72373429c36f82d888dbcbab080038f033",
      block_number: String(block),
      tx_hash: `0x${String(block).padStart(64, "0")}`,
      gas_used: "100",
      block_time: `2026-07-28T00:0${10 - block}:00.000Z`,
      event_payload: {},
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/rpc/executor_scorecard_aggregate")) {
        return new Response(
          JSON.stringify([{
            attempts: 3,
            finalized: 3,
            reverted: 0,
            reliability_bps: 10_000,
            unique_zaps: 1,
            total_gas_used: "300",
            first_block: "8",
            last_block: "10",
            last_execution_at: "2026-07-28T00:02:00.000Z",
            executor_fees_by_asset: {},
            executor_fee_asset_count: 0,
          }]),
          { status: 200 },
        );
      }
      expect(url).toContain("provenance_verified=eq.true");
      expect(url).toContain("limit=3");
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const page = await executorScorecardPage(EXECUTOR, 2, null);
      expect(page.scorecard.attempts).toBe(3);
      expect(page.history.map((receipt) => receipt.blockNumber)).toEqual(["10", "9"]);
      expect(page.nextCursor).not.toBeNull();
      expect(decodeScorecardCursor(page.nextCursor as string)).toMatchObject({ blockNumber: "9" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unbounded page sizes and malformed cursors", () => {
    expect(scorecardPageLimit(null)).toBe(20);
    expect(scorecardPageLimit("50")).toBe(50);
    expect(() => scorecardPageLimit("51")).toThrow("1 to 50");
    expect(() => decodeScorecardCursor("x".repeat(513))).toThrow("malformed");
    expect(() =>
      encodeScorecardCursor({ blockNumber: "1", txHash: `0x${"AB".repeat(32)}` }),
    ).toThrow("malformed");
  });
});
