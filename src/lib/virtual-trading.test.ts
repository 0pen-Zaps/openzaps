import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STARTING_CASH_RAW,
  VIRTUAL_TRADING_FORMULA_VERSION,
  VIRTUAL_TRADING_MAX_TRADES,
  VIRTUAL_TRADING_SCHEMA_VERSION,
  VirtualTradingError,
  applyVirtualFill,
  calculateVirtualMetrics,
  createVirtualPortfolio,
  formatVirtualInput,
  parseVirtualAmount,
  parseVirtualFill,
  parseVirtualMarketSnapshot,
  parseVirtualPortfolioValuation,
  parseVirtualPortfolio,
  virtualFillPriceWad,
  type VirtualFill,
  type VirtualPortfolioValuation,
} from "@/lib/virtual-trading";

const NOW = "2026-07-30T16:00:00.000Z";

function fill(overrides: Partial<VirtualFill> = {}): VirtualFill {
  return {
    clientOrderId: "order-0001",
    portfolioRevision: 0,
    marketId: "weth",
    side: "buy",
    routeId: "robinhood-v4-usdg-weth",
    inputRaw: "1000000000",
    outputRaw: "500000000000000000",
    gasEstimate: "12345",
    chainId: 4663,
    blockNumber: "23258886",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "1785430000",
    quotedAt: NOW,
    expiresAt: "2026-07-30T16:00:45.000Z",
    ...overrides,
  };
}

function valuation(
  overrides: Partial<VirtualPortfolioValuation> = {},
): VirtualPortfolioValuation {
  return {
    portfolioRevision: 1,
    chainId: 4663,
    blockNumber: "23258887",
    blockHash: `0x${"bc".repeat(32)}`,
    blockTimestamp: "1785430001",
    readAt: NOW,
    source: "canonical Robinhood Chain head eth_call",
    positions: {
      zaps: {
        quoteKind: "standalone-full-position",
        routeId: "robinhood-v4-route-zaps-usdg",
        inputRaw: "0",
        outputRaw: "0",
      },
      weth: {
        quoteKind: "standalone-full-position",
        routeId: "robinhood-v4-weth-usdg",
        inputRaw: "500000000000000000",
        outputRaw: "1100000000",
      },
    },
    portfolioRouteIds: [
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
    ],
    portfolioOutputRaw: "1100000000",
    ...overrides,
  };
}

describe("virtual portfolio ledger", () => {
  it("starts with 10,000 virtual USDG and no positions", () => {
    const portfolio = createVirtualPortfolio(NOW);

    expect(portfolio).toMatchObject({
      schemaVersion: VIRTUAL_TRADING_SCHEMA_VERSION,
      formulaVersion: VIRTUAL_TRADING_FORMULA_VERSION,
      revision: 0,
      startCashRaw: "10000000000",
      cashRaw: "10000000000",
      turnoverRaw: "0",
      positions: {
        zaps: { quantityRaw: "0", costBasisRaw: "0" },
        weth: { quantityRaw: "0", costBasisRaw: "0" },
      },
    });
    expect(BigInt(portfolio.cashRaw)).toBe(STARTING_CASH_RAW);
  });

  it("applies a canonical-head buy without touching a wallet balance", () => {
    const portfolio = applyVirtualFill(
      createVirtualPortfolio(NOW),
      fill(),
      Date.parse("2026-07-30T16:00:10.000Z"),
    );

    expect(portfolio.revision).toBe(1);
    expect(portfolio.cashRaw).toBe("9000000000");
    expect(portfolio.positions.weth).toEqual({
      quantityRaw: "500000000000000000",
      costBasisRaw: "1000000000",
    });
    expect(portfolio.turnoverRaw).toBe("1000000000");
    expect(portfolio.trades[0]).toMatchObject({
      releasedCostBasisRaw: "0",
      realizedPnlRaw: "0",
      blockNumber: "23258886",
    });
  });

  it("uses proportional bigint cost basis and realizes PnL on a sell", () => {
    const bought = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));
    const sold = applyVirtualFill(
      bought,
      fill({
        clientOrderId: "order-0002",
        portfolioRevision: 1,
        side: "sell",
        routeId: "robinhood-v4-weth-usdg",
        inputRaw: "250000000000000000",
        outputRaw: "600000000",
        quotedAt: "2026-07-30T16:01:00.000Z",
        expiresAt: "2026-07-30T16:01:45.000Z",
      }),
      Date.parse("2026-07-30T16:01:10.000Z"),
    );

    expect(sold.cashRaw).toBe("9600000000");
    expect(sold.positions.weth).toEqual({
      quantityRaw: "250000000000000000",
      costBasisRaw: "500000000",
    });
    expect(sold.realizedPnlRaw).toBe("100000000");
    expect(sold.trades[0]).toMatchObject({
      releasedCostBasisRaw: "500000000",
      realizedPnlRaw: "100000000",
    });
  });

  it("persists a realized loss as a signed fixed-point amount", () => {
    const bought = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));
    const sold = applyVirtualFill(
      bought,
      fill({
        clientOrderId: "order-loss",
        portfolioRevision: 1,
        side: "sell",
        routeId: "robinhood-v4-weth-usdg",
        inputRaw: "500000000000000000",
        outputRaw: "800000000",
        quotedAt: "2026-07-30T16:01:00.000Z",
        expiresAt: "2026-07-30T16:01:45.000Z",
      }),
      Date.parse("2026-07-30T16:01:10.000Z"),
    );

    expect(sold.realizedPnlRaw).toBe("-200000000");
    expect(sold.trades[0]?.realizedPnlRaw).toBe("-200000000");
    expect(parseVirtualPortfolio(JSON.stringify(sold))).toEqual(sold);
  });

  it("rejects overspending, shorting, stale revisions, duplicate IDs, expired quotes, and wrong routes", () => {
    const fresh = createVirtualPortfolio(NOW);
    expect(() =>
      applyVirtualFill(fresh, fill({ inputRaw: "10000000001" }), Date.parse(NOW)),
    ).toThrow("exceeds available");

    expect(() =>
      applyVirtualFill(
        fresh,
        fill({ side: "sell", routeId: "robinhood-v4-weth-usdg", inputRaw: "1" }),
        Date.parse(NOW),
      ),
    ).toThrow("Short selling is disabled");

    expect(() =>
      applyVirtualFill(fresh, fill({ portfolioRevision: 1 }), Date.parse(NOW)),
    ).toThrow("portfolio changed");

    expect(() =>
      applyVirtualFill(fresh, fill(), Date.parse("2026-07-30T16:01:00.000Z")),
    ).toThrow("expired");

    expect(() =>
      applyVirtualFill(fresh, fill({ routeId: "robinhood-v4-weth-zaps" }), Date.parse(NOW)),
    ).toThrow("does not match");

    expect(() =>
      applyVirtualFill(
        fresh,
        fill({ expiresAt: "2026-07-30T16:02:00.000Z" }),
        Date.parse(NOW),
      ),
    ).toThrow("expired");

    const once = applyVirtualFill(fresh, fill(), Date.parse(NOW));
    expect(() =>
      applyVirtualFill(
        { ...once, revision: 0 },
        fill(),
        Date.parse(NOW),
      ),
    ).toThrow("already applied");
  });

  it("bounds the stored ledger", () => {
    let portfolio = createVirtualPortfolio(NOW);
    for (let index = 0; index < VIRTUAL_TRADING_MAX_TRADES + 5; index += 1) {
      portfolio = applyVirtualFill(
        portfolio,
        fill({
          clientOrderId: `order-${String(index).padStart(4, "0")}`,
          portfolioRevision: portfolio.revision,
          inputRaw: "1",
          outputRaw: "1",
        }),
        Date.parse(NOW),
      );
    }
    expect(portfolio.trades).toHaveLength(VIRTUAL_TRADING_MAX_TRADES);
    expect(portfolio.revision).toBe(VIRTUAL_TRADING_MAX_TRADES + 5);
    expect(portfolio.turnoverRaw).toBe(String(VIRTUAL_TRADING_MAX_TRADES + 5));
  });
});

describe("virtual portfolio persistence", () => {
  it("round-trips a valid versioned portfolio", () => {
    const portfolio = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));
    expect(parseVirtualPortfolio(JSON.stringify(portfolio))).toEqual(portfolio);
  });

  const bought = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));

  it.each([
    null,
    "",
    "{",
    JSON.stringify({ schemaVersion: 99 }),
    JSON.stringify({ ...createVirtualPortfolio(NOW), cashRaw: "-1" }),
    JSON.stringify({ ...createVirtualPortfolio(NOW), formulaVersion: "future" }),
    JSON.stringify({ ...createVirtualPortfolio(NOW), positions: { weth: {}, zaps: {} } }),
    JSON.stringify({
      ...createVirtualPortfolio(NOW),
      positions: {
        ...createVirtualPortfolio(NOW).positions,
        zaps: { quantityRaw: "0", costBasisRaw: "1" },
      },
    }),
    JSON.stringify({ ...bought, revision: 0 }),
    JSON.stringify({ ...bought, turnoverRaw: "0" }),
    JSON.stringify({ ...bought, cashRaw: "9000000001" }),
    JSON.stringify({ ...bought, cashRaw: "9".repeat(79) }),
  ])("fails closed for malformed or incompatible storage", (raw) => {
    expect(parseVirtualPortfolio(raw)).toBeNull();
  });
});

describe("virtual API payload boundaries", () => {
  it("accepts only the exact canonical fill route and evidence", () => {
    expect(parseVirtualFill(fill())).toEqual(fill());
    expect(parseVirtualFill({ ...fill(), routeId: "wrong" })).toBeNull();
    expect(parseVirtualFill({ ...fill(), blockHash: "0x1234" })).toBeNull();
    expect(parseVirtualFill({ ...fill(), chainId: 1 })).toBeNull();
  });

  it("accepts a complete two-market canonical snapshot and rejects missing marks", () => {
    const snapshot = {
      chainId: 4663,
      blockNumber: "23258886",
      blockHash: `0x${"cd".repeat(32)}`,
      blockTimestamp: "1785430000",
      readAt: NOW,
      source: "canonical Robinhood Chain head eth_call",
      markets: [
        {
          marketId: "zaps",
          symbol: "0xZAPS",
          routeId: "robinhood-v4-route-zaps-usdg",
          sampleInputRaw: "1000000000000000000000000",
          sampleOutputRaw: "733800",
          priceWad: "733800000000",
        },
        {
          marketId: "weth",
          symbol: "aeWETH",
          routeId: "robinhood-v4-weth-usdg",
          sampleInputRaw: "10000000000000000",
          sampleOutputRaw: "19180000",
          priceWad: "1918000000000000000000",
        },
      ],
    };

    expect(parseVirtualMarketSnapshot(snapshot)).toEqual(snapshot);
    expect(parseVirtualMarketSnapshot({ ...snapshot, markets: snapshot.markets.slice(0, 1) })).toBeNull();
    expect(parseVirtualMarketSnapshot({
      ...snapshot,
      markets: [snapshot.markets[0], snapshot.markets[0]],
    })).toBeNull();
  });

  it("accepts only a route-bound whole-portfolio valuation", () => {
    const exact = valuation();

    expect(parseVirtualPortfolioValuation(exact)).toEqual(exact);
    expect(parseVirtualPortfolioValuation({
      ...exact,
      positions: {
        ...exact.positions,
        weth: { ...exact.positions.weth, inputRaw: "01" },
      },
    })).toBeNull();
    expect(parseVirtualPortfolioValuation({
      ...exact,
      portfolioRouteIds: ["robinhood-v4-weth-usdg", "robinhood-v4-zaps-weth"],
    })).toBeNull();
    expect(parseVirtualPortfolioValuation({ ...exact, portfolioOutputRaw: "0" })).toBeNull();
  });
});

describe("virtual practice authority boundary", () => {
  it("keeps wallet and transaction capabilities out of the client surface", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/(site)/virtual-trading/VirtualTradingDesk.tsx", import.meta.url)),
      "utf8",
    );

    for (const forbidden of [
      "useWalletSession",
      "getInjectedProvider",
      "createWalletClient",
      "writeContract",
      "sendTransaction",
      "wallet_requestPermissions",
      "eth_sendTransaction",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("fixed-point virtual metrics", () => {
  it("parses decimal input without floating point", () => {
    expect(parseVirtualAmount("1.25", 6)).toBe(1_250_000n);
    expect(parseVirtualAmount("0.000001", 6)).toBe(1n);
    expect(() => parseVirtualAmount("0.0000001", 6)).toThrow(VirtualTradingError);
    expect(() => parseVirtualAmount("-1", 6)).toThrow(VirtualTradingError);
  });

  it("round-trips a MAX token input without Number precision loss", () => {
    const raw = "134480239347745711057885086";
    const exact = formatVirtualInput(raw, 18);
    expect(exact).toBe("134480239.347745711057885086");
    expect(parseVirtualAmount(exact, 18)).toBe(BigInt(raw));
  });

  it("derives an effective virtual USDG price from exact fill amounts", () => {
    expect(virtualFillPriceWad(fill())).toBe(2_000_000_000_000_000_000_000n);
    expect(virtualFillPriceWad(fill({
      side: "sell",
      routeId: "robinhood-v4-weth-usdg",
      inputRaw: "500000000000000000",
      outputRaw: "900000000",
    }))).toBe(1_800_000_000_000_000_000_000n);
  });

  it("computes NAV, PnL, return, and turnover from a deterministic portfolio exit", () => {
    const bought = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));
    const metrics = calculateVirtualMetrics(bought, valuation());

    expect(metrics).toMatchObject({
      status: "ready",
      navRaw: "10100000000",
      unrealizedPnlRaw: "100000000",
      realizedPnlRaw: "0",
      totalPnlRaw: "100000000",
      returnBps: "100",
      turnoverRaw: "1000000000",
    });
  });

  it("rejects a valuation that does not echo the current full position", () => {
    const bought = applyVirtualFill(createVirtualPortfolio(NOW), fill(), Date.parse(NOW));
    const metrics = calculateVirtualMetrics(bought, valuation({
      positions: {
        ...valuation().positions,
        weth: { ...valuation().positions.weth, inputRaw: "1" },
      },
    }));

    expect(metrics.status).toBe("unavailable");
    expect(metrics.navRaw).toBeNull();
    expect(metrics.positionValueRaw.weth).toBeNull();
    expect(metrics.totalPnlRaw).toBeNull();
  });
});
