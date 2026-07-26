import { getAddress, type Address } from "viem";

export type PortfolioAssetKind = "native" | "token" | "vault-share" | "lp-share";
export type PortfolioValuationStatus = "complete" | "partial" | "unavailable" | "empty";

export interface PortfolioHoldingInput {
  id: string;
  symbol: string;
  name: string;
  address: Address | null;
  decimals: number;
  kind: PortfolioAssetKind;
  balance: bigint | null;
  valueEth: bigint | null;
  valuationSourceLabel: string | null;
  valuationSourceUrl: string | null;
  unpricedReason: string | null;
}

export interface WalletPortfolioHolding {
  id: string;
  symbol: string;
  name: string;
  address: Address | null;
  decimals: number;
  kind: PortfolioAssetKind;
  balance: string | null;
  balanceStatus: "live" | "unavailable";
  valueEth: string | null;
  valuationStatus: "priced" | "unpriced" | "not-applicable" | "unavailable";
  valuationSourceLabel: string | null;
  valuationSourceUrl: string | null;
  valuationCaveat: string | null;
}

export interface WalletPortfolioPayload {
  owner: Address;
  chainId: 4663;
  sourceStatus: "live" | "degraded";
  sourceLabel: "Robinhood Chain RPC balances + onchain route quotes";
  sourceCaveat: string;
  headBlock: string;
  updatedAt: string;
  valuationStatus: PortfolioValuationStatus;
  pricedSubtotalEth: string;
  pricedHoldingCount: number;
  unpricedHoldingCount: number;
  nonzeroHoldingCount: number;
  readFailureCount: number;
  trackedAssetCount: number;
  holdings: WalletPortfolioHolding[];
}

export interface AggregateWalletPortfolioInput {
  owner: Address;
  headBlock: bigint;
  updatedAt: string;
  holdings: readonly PortfolioHoldingInput[];
}

/** Normalize independently-read balances and quotes without treating missing data as zero. */
export function aggregateWalletPortfolio(input: AggregateWalletPortfolioInput): WalletPortfolioPayload {
  const holdings = input.holdings.map(normalizeHolding);
  const readFailureCount = holdings.filter((holding) => holding.balanceStatus === "unavailable").length;
  const nonzero = holdings.filter((holding) => holding.balance !== null && BigInt(holding.balance) > 0n);
  const priced = nonzero.filter((holding) => holding.valuationStatus === "priced" && holding.valueEth !== null);
  const unpriced = nonzero.filter((holding) => holding.valuationStatus !== "priced");
  const pricedSubtotalEth = priced.reduce((total, holding) => total + BigInt(holding.valueEth ?? "0"), 0n);

  const valuationStatus: PortfolioValuationStatus =
    nonzero.length === 0
      ? readFailureCount === 0 ? "empty" : "unavailable"
      : priced.length === nonzero.length && readFailureCount === 0
        ? "complete"
        : priced.length > 0
          ? "partial"
          : "unavailable";

  return {
    owner: getAddress(input.owner),
    chainId: 4663,
    sourceStatus: readFailureCount === 0 ? "live" : "degraded",
    sourceLabel: "Robinhood Chain RPC balances + onchain route quotes",
    sourceCaveat:
      "Curated Robinhood Chain assets only. The ETH subtotal includes only balances with a successful direct denomination or executable-size onchain route quote; unpriced and unreadable assets are excluded, so it is not total net worth.",
    headBlock: input.headBlock.toString(),
    updatedAt: input.updatedAt,
    valuationStatus,
    pricedSubtotalEth: pricedSubtotalEth.toString(),
    pricedHoldingCount: priced.length,
    unpricedHoldingCount: unpriced.length,
    nonzeroHoldingCount: nonzero.length,
    readFailureCount,
    trackedAssetCount: holdings.length,
    holdings,
  };
}

function normalizeHolding(input: PortfolioHoldingInput): WalletPortfolioHolding {
  if (input.balance === null) {
    return {
      ...baseHolding(input),
      balance: null,
      balanceStatus: "unavailable",
      valueEth: null,
      valuationStatus: "unavailable",
      valuationSourceLabel: null,
      valuationSourceUrl: null,
      valuationCaveat: "Balance read failed; no zero balance or valuation was inferred.",
    };
  }

  if (input.balance === 0n) {
    return {
      ...baseHolding(input),
      balance: "0",
      balanceStatus: "live",
      valueEth: null,
      valuationStatus: "not-applicable",
      valuationSourceLabel: input.valuationSourceLabel,
      valuationSourceUrl: input.valuationSourceUrl,
      valuationCaveat: null,
    };
  }

  if (input.valueEth !== null && input.valueEth >= 0n) {
    return {
      ...baseHolding(input),
      balance: input.balance.toString(),
      balanceStatus: "live",
      valueEth: input.valueEth.toString(),
      valuationStatus: "priced",
      valuationSourceLabel: input.valuationSourceLabel,
      valuationSourceUrl: input.valuationSourceUrl,
      valuationCaveat: input.unpricedReason,
    };
  }

  return {
    ...baseHolding(input),
    balance: input.balance.toString(),
    balanceStatus: "live",
    valueEth: null,
    valuationStatus: "unpriced",
    valuationSourceLabel: input.valuationSourceLabel,
    valuationSourceUrl: input.valuationSourceUrl,
    valuationCaveat: input.unpricedReason ?? "No defensible ETH-denominated source was available.",
  };
}

function baseHolding(input: PortfolioHoldingInput): Pick<
  WalletPortfolioHolding,
  "id" | "symbol" | "name" | "address" | "decimals" | "kind"
> {
  return {
    id: input.id,
    symbol: input.symbol,
    name: input.name,
    address: input.address,
    decimals: input.decimals,
    kind: input.kind,
  };
}
