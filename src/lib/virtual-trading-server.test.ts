import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import {
  fetchVirtualFill,
  fetchVirtualMarketSnapshot,
  fetchVirtualPortfolioValuation,
} from "@/lib/virtual-trading-server";

const BLOCK_HASH = `0x${"11".repeat(32)}` as const;
const OTHER_BLOCK_HASH = `0x${"22".repeat(32)}` as const;

function pinnedClient(
  after: { number: bigint; hash: `0x${string}`; timestamp: bigint } = {
    number: 500n,
    hash: BLOCK_HASH,
    timestamp: 1_800_000_000n,
  },
) {
  const getBlock = vi.fn()
    .mockResolvedValueOnce({
      number: 500n,
      hash: BLOCK_HASH,
      timestamp: 1_800_000_000n,
    })
    .mockResolvedValueOnce(after);
  return {
    getBlock,
    client: { getBlock } as unknown as PublicClient,
  };
}

describe("virtual trading canonical-head quote server", () => {
  it("prices both markets from fixed sell samples while the canonical head is unchanged", async () => {
    const { client, getBlock } = pinnedClient();
    const quoter = vi.fn()
      .mockResolvedValueOnce({ amountOut: 500_000_000n, gasEstimate: 100n })
      .mockResolvedValueOnce({ amountOut: 25_000_000n, gasEstimate: 200n });

    const snapshot = await fetchVirtualMarketSnapshot(
      client,
      quoter,
      () => new Date("2027-01-15T12:00:00.000Z"),
    );

    expect(snapshot).toEqual({
      chainId: 4663,
      blockNumber: "500",
      blockHash: BLOCK_HASH,
      blockTimestamp: "1800000000",
      readAt: "2027-01-15T12:00:00.000Z",
      source: "canonical Robinhood Chain head eth_call",
      markets: [
        {
          marketId: "zaps",
          symbol: "0xZAPS",
          routeId: "robinhood-v4-route-zaps-usdg",
          sampleInputRaw: "1000000000000000000000000",
          sampleOutputRaw: "500000000",
          priceWad: "500000000000000",
        },
        {
          marketId: "weth",
          symbol: "aeWETH",
          routeId: "robinhood-v4-weth-usdg",
          sampleInputRaw: "10000000000000000",
          sampleOutputRaw: "25000000",
          priceWad: "2500000000000000000000",
        },
      ],
    });
    expect(quoter).toHaveBeenCalledTimes(2);
    expect(quoter.mock.calls.every((call) => call[4] === undefined)).toBe(true);
    expect(quoter.mock.calls.every((call) => call[5] === undefined)).toBe(true);
    expect(getBlock.mock.calls[0]?.[0]).toEqual({
      blockTag: "latest",
      includeTransactions: false,
    });
    expect(getBlock.mock.calls[1]?.[0]).toEqual({
      blockTag: "latest",
      includeTransactions: false,
    });
  });

  it("returns a VirtualFill with the exact route amounts, gas, block evidence, and 45s expiry", async () => {
    const { client } = pinnedClient();
    const quoter = vi.fn().mockResolvedValue({
      amountOut: 123_456_789n,
      gasEstimate: 88_000n,
    });

    const fill = await fetchVirtualFill(
      {
        marketId: "zaps",
        side: "buy",
        inputRaw: 50_000_000n,
        clientOrderId: "order-12345678",
        portfolioRevision: 7,
      },
      client,
      quoter,
      () => new Date("2027-01-15T12:00:00.000Z"),
    );

    expect(fill).toEqual({
      clientOrderId: "order-12345678",
      portfolioRevision: 7,
      marketId: "zaps",
      side: "buy",
      routeId: "robinhood-v4-route-usdg-zaps",
      inputRaw: "50000000",
      outputRaw: "123456789",
      gasEstimate: "88000",
      chainId: 4663,
      blockNumber: "500",
      blockHash: BLOCK_HASH,
      blockTimestamp: "1800000000",
      quotedAt: "2027-01-15T12:00:00.000Z",
      expiresAt: "2027-01-15T12:00:45.000Z",
    });
    expect(quoter.mock.calls[0]?.[1].id).toBe("robinhood-v4-route-usdg-zaps");
    expect(quoter.mock.calls[0]?.[2]).toBe(50_000_000n);
    expect(quoter.mock.calls[0]?.[4]).toBeUndefined();
    expect(quoter.mock.calls[0]?.[5]).toBeUndefined();
  });

  it("quotes each complete positive position into USDG at one unchanged head", async () => {
    const { client, getBlock } = pinnedClient();
    const quoter = vi.fn()
      .mockResolvedValueOnce({ amountOut: 700n, gasEstimate: 11n })
      .mockResolvedValueOnce({ amountOut: 1_300n, gasEstimate: 22n })
      .mockResolvedValueOnce({ amountOut: 500n, gasEstimate: 33n })
      .mockResolvedValueOnce({ amountOut: 1_900n, gasEstimate: 44n });

    const valuation = await fetchVirtualPortfolioValuation(
      {
        zapsRaw: 123_456n,
        wethRaw: 789_012n,
        portfolioRevision: 9,
      },
      client,
      quoter,
      () => new Date("2027-01-15T12:00:00.000Z"),
    );

    expect(valuation).toEqual({
      portfolioRevision: 9,
      chainId: 4663,
      blockNumber: "500",
      blockHash: BLOCK_HASH,
      blockTimestamp: "1800000000",
      readAt: "2027-01-15T12:00:00.000Z",
      source: "canonical Robinhood Chain head eth_call",
      positions: {
        zaps: {
          quoteKind: "standalone-full-position",
          routeId: "robinhood-v4-route-zaps-usdg",
          inputRaw: "123456",
          outputRaw: "700",
        },
        weth: {
          quoteKind: "standalone-full-position",
          routeId: "robinhood-v4-weth-usdg",
          inputRaw: "789012",
          outputRaw: "1300",
        },
      },
      portfolioRouteIds: [
        "robinhood-v4-zaps-weth",
        "robinhood-v4-weth-usdg",
      ],
      portfolioOutputRaw: "1900",
    });
    expect(quoter.mock.calls.map((call) => call[1].id)).toEqual([
      "robinhood-v4-route-zaps-usdg",
      "robinhood-v4-weth-usdg",
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
    ]);
    expect(quoter.mock.calls.map((call) => call[2])).toEqual([
      123_456n,
      789_012n,
      123_456n,
      789_512n,
    ]);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it("returns exact zero values without invoking a sell quote", async () => {
    const { client } = pinnedClient();
    const quoter = vi.fn();

    const valuation = await fetchVirtualPortfolioValuation(
      {
        zapsRaw: 0n,
        wethRaw: 0n,
        portfolioRevision: 0,
      },
      client,
      quoter,
      () => new Date("2027-01-15T12:00:00.000Z"),
    );

    expect(valuation.positions.zaps).toMatchObject({
      quoteKind: "standalone-full-position",
      inputRaw: "0",
      outputRaw: "0",
    });
    expect(valuation.positions.weth).toMatchObject({
      quoteKind: "standalone-full-position",
      inputRaw: "0",
      outputRaw: "0",
    });
    expect(valuation.portfolioOutputRaw).toBe("0");
    expect(quoter).not.toHaveBeenCalled();
  });

  it("reuses the standalone aeWETH quote as the aggregate when 0xZAPS is zero", async () => {
    const { client } = pinnedClient();
    const quoter = vi.fn().mockResolvedValue({
      amountOut: 1_300n,
      gasEstimate: 22n,
    });

    const valuation = await fetchVirtualPortfolioValuation(
      {
        zapsRaw: 0n,
        wethRaw: 789_012n,
        portfolioRevision: 2,
      },
      client,
      quoter,
    );

    expect(valuation.positions.zaps.outputRaw).toBe("0");
    expect(valuation.positions.weth.outputRaw).toBe("1300");
    expect(valuation.portfolioOutputRaw).toBe("1300");
    expect(quoter).toHaveBeenCalledTimes(1);
    expect(quoter.mock.calls[0]?.[1].id).toBe("robinhood-v4-weth-usdg");
    expect(quoter.mock.calls[0]?.[2]).toBe(789_012n);
  });

  it("rejects out-of-range portfolio inputs before reading chain state", async () => {
    const getBlock = vi.fn();
    const quoter = vi.fn();

    await expect(
      fetchVirtualPortfolioValuation(
        {
          zapsRaw: 1n << 128n,
          wethRaw: 0n,
          portfolioRevision: 0,
        },
        { getBlock } as unknown as PublicClient,
        quoter,
      ),
    ).rejects.toThrow("fit uint128");
    expect(getBlock).not.toHaveBeenCalled();
    expect(quoter).not.toHaveBeenCalled();
  });

  it("retries a quote discarded by one moving head", async () => {
    const getBlock = vi.fn()
      .mockResolvedValueOnce({ number: 500n, hash: BLOCK_HASH, timestamp: 1_800_000_000n })
      .mockResolvedValueOnce({ number: 501n, hash: OTHER_BLOCK_HASH, timestamp: 1_800_000_001n })
      .mockResolvedValueOnce({ number: 501n, hash: OTHER_BLOCK_HASH, timestamp: 1_800_000_001n })
      .mockResolvedValueOnce({ number: 501n, hash: OTHER_BLOCK_HASH, timestamp: 1_800_000_001n });
    const client = { getBlock } as unknown as PublicClient;
    const quoter = vi.fn()
      .mockResolvedValueOnce({ amountOut: 1n, gasEstimate: null })
      .mockResolvedValueOnce({ amountOut: 2n, gasEstimate: null });

    const fill = await fetchVirtualFill(
      {
        marketId: "weth",
        side: "sell",
        inputRaw: 1n,
        clientOrderId: "order-retry",
        portfolioRevision: 0,
      },
      client,
      quoter,
    );

    expect(fill.blockNumber).toBe("501");
    expect(fill.blockHash).toBe(OTHER_BLOCK_HASH);
    expect(fill.outputRaw).toBe("2");
    expect(quoter).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the canonical head moves through every bounded attempt", async () => {
    const getBlock = vi.fn();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      getBlock
        .mockResolvedValueOnce({
          number: BigInt(500 + attempt),
          hash: BLOCK_HASH,
          timestamp: 1_800_000_000n + BigInt(attempt),
        })
        .mockResolvedValueOnce({
          number: BigInt(501 + attempt),
          hash: OTHER_BLOCK_HASH,
          timestamp: 1_800_000_001n + BigInt(attempt),
        });
    }
    const client = { getBlock } as unknown as PublicClient;
    const quoter = vi.fn().mockResolvedValue({ amountOut: 1n, gasEstimate: null });

    await expect(
      fetchVirtualFill(
        {
          marketId: "weth",
          side: "sell",
          inputRaw: 1n,
          clientOrderId: "order-abcdefgh",
          portfolioRevision: 0,
        },
        client,
        quoter,
      ),
    ).rejects.toThrow("canonical head changed");
    expect(quoter).toHaveBeenCalledTimes(3);
  });

  it("fails before quoting when canonical head evidence is missing", async () => {
    const getBlock = vi.fn().mockResolvedValue({
      number: 500n,
      hash: null,
      timestamp: 1_800_000_000n,
    });
    const quoter = vi.fn();

    await expect(
      fetchVirtualMarketSnapshot(
        { getBlock } as unknown as PublicClient,
        quoter,
      ),
    ).rejects.toThrow("missing block evidence");
    expect(quoter).not.toHaveBeenCalled();
  });
});
