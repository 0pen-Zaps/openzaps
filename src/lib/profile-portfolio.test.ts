import { describe, expect, it } from "vitest";

import {
  aggregateWalletPortfolio,
  type PortfolioHoldingInput,
} from "@/lib/profile-portfolio";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;

function holding(overrides: Partial<PortfolioHoldingInput> = {}): PortfolioHoldingInput {
  return {
    id: "eth",
    symbol: "ETH",
    name: "Native ETH",
    address: null,
    decimals: 18,
    kind: "native",
    balance: 0n,
    valueEth: null,
    valuationSourceLabel: "Native ETH denomination",
    valuationSourceUrl: null,
    unpricedReason: null,
    ...overrides,
  };
}

function aggregate(holdings: PortfolioHoldingInput[]) {
  return aggregateWalletPortfolio({
    owner: OWNER,
    headBlock: 123n,
    updatedAt: "2026-07-26T00:00:00.000Z",
    holdings,
  });
}

describe("aggregateWalletPortfolio", () => {
  it("asserts an empty tracked portfolio only when every balance read succeeded", () => {
    const result = aggregate([
      holding(),
      holding({ id: "token", symbol: "TOKEN", address: TOKEN, kind: "token" }),
    ]);

    expect(result.valuationStatus).toBe("empty");
    expect(result.sourceStatus).toBe("live");
    expect(result.nonzeroHoldingCount).toBe(0);
    expect(result.pricedSubtotalEth).toBe("0");
  });

  it("does not turn a failed balance read into an empty portfolio", () => {
    const result = aggregate([
      holding(),
      holding({ id: "token", symbol: "TOKEN", address: TOKEN, kind: "token", balance: null }),
    ]);

    expect(result.valuationStatus).toBe("unavailable");
    expect(result.sourceStatus).toBe("degraded");
    expect(result.readFailureCount).toBe(1);
    expect(result.holdings[1].balance).toBeNull();
    expect(result.holdings[1].valuationStatus).toBe("unavailable");
  });

  it("sums only priced balances and labels a nonzero unpriced asset as partial", () => {
    const result = aggregate([
      holding({ balance: 2_000_000_000_000_000_000n, valueEth: 2_000_000_000_000_000_000n }),
      holding({
        id: "zaps",
        symbol: "0xZAPS",
        address: TOKEN,
        kind: "token",
        balance: 1_000_000_000_000_000_000n,
        valueEth: 400_000_000_000_000_000n,
        valuationSourceLabel: "Pinned 0xZAPS → aeWETH route quote",
      }),
      holding({
        id: "vault",
        symbol: "ozUSDG",
        address: "0x3333333333333333333333333333333333333333",
        kind: "vault-share",
        decimals: 9,
        balance: 500_000_000n,
        valueEth: null,
        valuationSourceLabel: null,
        unpricedReason: "Vault-share valuation is intentionally withheld.",
      }),
    ]);

    expect(result.valuationStatus).toBe("partial");
    expect(result.pricedSubtotalEth).toBe("2400000000000000000");
    expect(result.pricedHoldingCount).toBe(2);
    expect(result.unpricedHoldingCount).toBe(1);
    expect(result.holdings[2].valuationStatus).toBe("unpriced");
  });

  it("reports complete coverage when every nonzero tracked balance is priced", () => {
    const result = aggregate([
      holding({ balance: 1n, valueEth: 1n }),
      holding({ id: "token", symbol: "TOKEN", address: TOKEN, kind: "token", balance: 2n, valueEth: 3n }),
    ]);

    expect(result.valuationStatus).toBe("complete");
    expect(result.pricedSubtotalEth).toBe("4");
    expect(result.unpricedHoldingCount).toBe(0);
  });
});
