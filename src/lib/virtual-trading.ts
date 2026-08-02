import { formatUnits, parseUnits } from "viem";

import { ROBINHOOD_ASSETS } from "@/lib/robinhood";

/**
 * Browser-local, unranked virtual trading.
 *
 * This module never touches a wallet or a contract write path. The only
 * state-changing operation is `applyVirtualFill`, which moves fixed-point
 * integers inside a versioned practice portfolio after the server has returned
 * a canonical-head eth_call quote guarded by a before/after block-hash check.
 */

export const VIRTUAL_TRADING_SCHEMA_VERSION = 1 as const;
export const VIRTUAL_TRADING_FORMULA_VERSION = "virtual-practice-v1" as const;
export const VIRTUAL_TRADING_STORAGE_KEY = "openzaps.virtual-trading.v1";
export const VIRTUAL_TRADING_MAX_TRADES = 200;
export const VIRTUAL_QUOTE_TTL_MS = 45_000;

export const USDG_DECIMALS = 6;
export const PRICE_WAD_DECIMALS = 18;
export const STARTING_CASH_RAW = 10_000n * 10n ** BigInt(USDG_DECIMALS);

export const VIRTUAL_MARKETS = {
  zaps: {
    id: "zaps",
    name: "OpenZaps",
    symbol: "0xZAPS",
    tokenAddress: ROBINHOOD_ASSETS.zaps,
    decimals: 18,
    buyRouteId: "robinhood-v4-route-usdg-zaps",
    sellRouteId: "robinhood-v4-route-zaps-usdg",
  },
  weth: {
    id: "weth",
    name: "Wrapped Ether",
    symbol: "aeWETH",
    tokenAddress: ROBINHOOD_ASSETS.weth,
    decimals: 18,
    buyRouteId: "robinhood-v4-usdg-weth",
    sellRouteId: "robinhood-v4-weth-usdg",
  },
} as const;

export type VirtualMarketId = keyof typeof VIRTUAL_MARKETS;
export type VirtualOrderSide = "buy" | "sell";

export interface VirtualPosition {
  /** Token quantity in the market token's native decimals. */
  quantityRaw: string;
  /** Remaining acquisition cost in virtual USDG raw units (6 decimals). */
  costBasisRaw: string;
}

export interface VirtualFill {
  clientOrderId: string;
  portfolioRevision: number;
  marketId: VirtualMarketId;
  side: VirtualOrderSide;
  routeId: string;
  inputRaw: string;
  outputRaw: string;
  gasEstimate: string | null;
  chainId: 4663;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: string;
  quotedAt: string;
  expiresAt: string;
}

export interface VirtualTrade extends VirtualFill {
  portfolioRevisionAfter: number;
  /** Cost removed on a sell, zero for a buy. Virtual USDG raw units. */
  releasedCostBasisRaw: string;
  /** Realized PnL for this fill, zero for a buy. Virtual USDG raw units. */
  realizedPnlRaw: string;
}

export interface VirtualPortfolio {
  schemaVersion: typeof VIRTUAL_TRADING_SCHEMA_VERSION;
  formulaVersion: typeof VIRTUAL_TRADING_FORMULA_VERSION;
  revision: number;
  startCashRaw: string;
  cashRaw: string;
  positions: Record<VirtualMarketId, VirtualPosition>;
  realizedPnlRaw: string;
  /** Lifetime virtual USDG notional across all fills, including trimmed history. */
  turnoverRaw: string;
  trades: VirtualTrade[];
  createdAt: string;
  updatedAt: string;
}

export interface VirtualMarketMark {
  marketId: VirtualMarketId;
  symbol: string;
  routeId: string;
  sampleInputRaw: string;
  sampleOutputRaw: string;
  /** Virtual USDG per whole token, scaled to 18 decimals. */
  priceWad: string;
}

export interface VirtualMarketSnapshot {
  chainId: 4663;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: string;
  readAt: string;
  source: "canonical Robinhood Chain head eth_call";
  markets: VirtualMarketMark[];
}

export interface VirtualPositionValuation {
  quoteKind: "standalone-full-position";
  routeId: string;
  inputRaw: string;
  /** Standalone virtual USDG output; shared-liquidity positions are not additive. */
  outputRaw: string;
}

export interface VirtualPortfolioValuation {
  portfolioRevision: number;
  chainId: 4663;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: string;
  readAt: string;
  source: "canonical Robinhood Chain head eth_call";
  positions: Record<VirtualMarketId, VirtualPositionValuation>;
  portfolioRouteIds: readonly [
    "robinhood-v4-zaps-weth",
    "robinhood-v4-weth-usdg",
  ];
  /** Deterministic aggregate exit: 0xZAPS -> aeWETH, then all aeWETH -> USDG. */
  portfolioOutputRaw: string;
}

export interface VirtualMetrics {
  status: "ready" | "unavailable";
  navRaw: string | null;
  positionValueRaw: Record<VirtualMarketId, string | null>;
  unrealizedPnlRaw: string | null;
  realizedPnlRaw: string;
  totalPnlRaw: string | null;
  returnBps: string | null;
  turnoverRaw: string;
}

export class VirtualTradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualTradingError";
  }
}

const RAW_INTEGER = /^(0|[1-9]\d*)$/;
const POSITIVE_RAW_INTEGER = /^[1-9]\d*$/;
const SIGNED_INTEGER = /^(0|-?[1-9]\d*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const CLIENT_ORDER_ID = /^[A-Za-z0-9-]{8,80}$/;
const MAX_UINT256_DECIMAL_DIGITS = 78;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawInteger(value: unknown, positive = false): value is string {
  return (
    typeof value === "string"
    && value.length <= MAX_UINT256_DECIMAL_DIGITS
    && (positive ? POSITIVE_RAW_INTEGER : RAW_INTEGER).test(value)
  );
}

function isSignedInteger(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length <= MAX_UINT256_DECIMAL_DIGITS + (value.startsWith("-") ? 1 : 0)
    && SIGNED_INTEGER.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));
}

export function isVirtualMarketId(value: unknown): value is VirtualMarketId {
  return typeof value === "string" && Object.hasOwn(VIRTUAL_MARKETS, value);
}

export function routeForVirtualOrder(marketId: VirtualMarketId, side: VirtualOrderSide): string {
  const market = VIRTUAL_MARKETS[marketId];
  return side === "buy" ? market.buyRouteId : market.sellRouteId;
}

export function virtualTradeDirectionLabel(
  marketId: VirtualMarketId,
  side: VirtualOrderSide,
): string {
  const market = VIRTUAL_MARKETS[marketId];
  return side === "buy"
    ? `USDG to ${market.symbol}`
    : `${market.symbol} to USDG`;
}

/**
 * Build a lead handoff from an enumerated paper route, never from runtime fill
 * data. Amounts, order ids, block evidence, PnL, and browser state cannot enter
 * this URL because the helper accepts only the market and direction unions.
 */
export function virtualTradeRequestHref(
  marketId: VirtualMarketId,
  side: VirtualOrderSide,
): string {
  const routeId = routeForVirtualOrder(marketId, side);
  const direction = virtualTradeDirectionLabel(marketId, side);
  const params = new URLSearchParams({
    intent:
      `Review a bounded live-action hypothesis based on the paper-tested ${direction} route. `
      + "Map the immutable target, route, assets, recipient, per-run cap, output floor, cadence, expiry, and recovery path.",
    asset: `Robinhood Chain 4663; Uniswap v4; ${direction}; route ${routeId}`,
    utm_source: "openzaps",
    utm_medium: "product",
    utm_campaign: "request_a_zap",
    utm_content: "virtual_trading",
  });
  return `/request-a-zap?${params.toString()}`;
}

export function createVirtualPortfolio(now = new Date().toISOString()): VirtualPortfolio {
  return {
    schemaVersion: VIRTUAL_TRADING_SCHEMA_VERSION,
    formulaVersion: VIRTUAL_TRADING_FORMULA_VERSION,
    revision: 0,
    startCashRaw: STARTING_CASH_RAW.toString(),
    cashRaw: STARTING_CASH_RAW.toString(),
    positions: {
      zaps: { quantityRaw: "0", costBasisRaw: "0" },
      weth: { quantityRaw: "0", costBasisRaw: "0" },
    },
    realizedPnlRaw: "0",
    turnoverRaw: "0",
    trades: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parsePosition(value: unknown): VirtualPosition | null {
  if (!isRecord(value)) return null;
  if (!isRawInteger(value.quantityRaw) || !isRawInteger(value.costBasisRaw)) return null;
  return { quantityRaw: value.quantityRaw, costBasisRaw: value.costBasisRaw };
}

export function parseVirtualFill(value: unknown): VirtualFill | null {
  if (!isRecord(value)) return null;
  if (!CLIENT_ORDER_ID.test(typeof value.clientOrderId === "string" ? value.clientOrderId : "")) return null;
  if (!Number.isSafeInteger(value.portfolioRevision) || Number(value.portfolioRevision) < 0) return null;
  if (!isVirtualMarketId(value.marketId)) return null;
  if (value.side !== "buy" && value.side !== "sell") return null;
  if (value.routeId !== routeForVirtualOrder(value.marketId, value.side)) return null;
  if (!isRawInteger(value.inputRaw, true) || !isRawInteger(value.outputRaw, true)) return null;
  if (value.gasEstimate !== null && !isRawInteger(value.gasEstimate)) return null;
  if (value.chainId !== 4663) return null;
  if (!isRawInteger(value.blockNumber, true)) return null;
  if (typeof value.blockHash !== "string" || !HEX_32.test(value.blockHash)) return null;
  if (!isRawInteger(value.blockTimestamp, true)) return null;
  if (!isIsoDate(value.quotedAt) || !isIsoDate(value.expiresAt)) return null;
  return value as unknown as VirtualFill;
}

function parseTrade(value: unknown): VirtualTrade | null {
  const fill = parseVirtualFill(value);
  if (!fill || !isRecord(value)) return null;
  if (!Number.isSafeInteger(value.portfolioRevisionAfter) || Number(value.portfolioRevisionAfter) < 1) return null;
  if (Number(value.portfolioRevisionAfter) !== fill.portfolioRevision + 1) return null;
  if (!isRawInteger(value.releasedCostBasisRaw) || !isSignedInteger(value.realizedPnlRaw)) return null;
  return value as unknown as VirtualTrade;
}

export function parseVirtualMarketSnapshot(value: unknown): VirtualMarketSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.chainId !== 4663) return null;
  if (!isRawInteger(value.blockNumber, true)) return null;
  if (typeof value.blockHash !== "string" || !HEX_32.test(value.blockHash)) return null;
  if (!isRawInteger(value.blockTimestamp, true)) return null;
  if (!isIsoDate(value.readAt)) return null;
  if (value.source !== "canonical Robinhood Chain head eth_call") return null;
  if (!Array.isArray(value.markets) || value.markets.length !== Object.keys(VIRTUAL_MARKETS).length) return null;

  const seen = new Set<VirtualMarketId>();
  const markets: VirtualMarketMark[] = [];
  for (const raw of value.markets) {
    if (!isRecord(raw) || !isVirtualMarketId(raw.marketId) || seen.has(raw.marketId)) return null;
    const market = VIRTUAL_MARKETS[raw.marketId];
    if (raw.symbol !== market.symbol || raw.routeId !== market.sellRouteId) return null;
    if (
      !isRawInteger(raw.sampleInputRaw, true)
      || !isRawInteger(raw.sampleOutputRaw, true)
      || !isRawInteger(raw.priceWad, true)
    ) return null;
    seen.add(raw.marketId);
    markets.push(raw as unknown as VirtualMarketMark);
  }

  return {
    chainId: 4663,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash as `0x${string}`,
    blockTimestamp: value.blockTimestamp,
    readAt: value.readAt,
    source: value.source,
    markets,
  };
}

export function parseVirtualPortfolioValuation(value: unknown): VirtualPortfolioValuation | null {
  if (!isRecord(value)) return null;
  if (!Number.isSafeInteger(value.portfolioRevision) || Number(value.portfolioRevision) < 0) return null;
  if (value.chainId !== 4663) return null;
  if (!isRawInteger(value.blockNumber, true)) return null;
  if (typeof value.blockHash !== "string" || !HEX_32.test(value.blockHash)) return null;
  if (!isRawInteger(value.blockTimestamp, true) || !isIsoDate(value.readAt)) return null;
  if (value.source !== "canonical Robinhood Chain head eth_call") return null;
  if (!isRecord(value.positions)) return null;
  if (Object.keys(value.positions).sort().join(",") !== "weth,zaps") return null;

  const positions = {} as Record<VirtualMarketId, VirtualPositionValuation>;
  for (const marketId of Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[]) {
    const raw = value.positions[marketId];
    if (!isRecord(raw)) return null;
    if (raw.quoteKind !== "standalone-full-position") return null;
    if (raw.routeId !== VIRTUAL_MARKETS[marketId].sellRouteId) return null;
    if (!isRawInteger(raw.inputRaw) || !isRawInteger(raw.outputRaw)) return null;
    if (BigInt(raw.inputRaw) > 0n && BigInt(raw.outputRaw) === 0n) return null;
    positions[marketId] = {
      quoteKind: raw.quoteKind,
      routeId: VIRTUAL_MARKETS[marketId].sellRouteId,
      inputRaw: raw.inputRaw,
      outputRaw: raw.outputRaw,
    };
  }

  if (
    !Array.isArray(value.portfolioRouteIds)
    || value.portfolioRouteIds.length !== 2
    || value.portfolioRouteIds[0] !== "robinhood-v4-zaps-weth"
    || value.portfolioRouteIds[1] !== "robinhood-v4-weth-usdg"
  ) return null;
  if (!isRawInteger(value.portfolioOutputRaw)) return null;
  const hasPosition = Object.values(positions).some(({ inputRaw }) => BigInt(inputRaw) > 0n);
  if (hasPosition !== (BigInt(value.portfolioOutputRaw) > 0n)) return null;

  return {
    portfolioRevision: Number(value.portfolioRevision),
    chainId: 4663,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash as `0x${string}`,
    blockTimestamp: value.blockTimestamp,
    readAt: value.readAt,
    source: value.source,
    positions,
    portfolioRouteIds: [
      "robinhood-v4-zaps-weth",
      "robinhood-v4-weth-usdg",
    ],
    portfolioOutputRaw: value.portfolioOutputRaw,
  };
}

/**
 * Parse persisted browser state without trusting it. Any invalid shape resets
 * the practice portfolio instead of letting malformed local data create a
 * negative balance, a short position, or an unbounded storage payload.
 */
export function parseVirtualPortfolio(raw: string | null): VirtualPortfolio | null {
  if (!raw || raw.length > 500_000) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== VIRTUAL_TRADING_SCHEMA_VERSION) return null;
  if (value.formulaVersion !== VIRTUAL_TRADING_FORMULA_VERSION) return null;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null;
  if (value.startCashRaw !== STARTING_CASH_RAW.toString()) return null;
  if (
    !isRawInteger(value.cashRaw)
    || !isSignedInteger(value.realizedPnlRaw)
    || !isRawInteger(value.turnoverRaw)
  ) return null;
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) return null;
  if (!isRecord(value.positions)) return null;

  const zaps = parsePosition(value.positions.zaps);
  const weth = parsePosition(value.positions.weth);
  if (!zaps || !weth) return null;
  if (!Array.isArray(value.trades) || value.trades.length > VIRTUAL_TRADING_MAX_TRADES) return null;
  const trades = value.trades.map(parseTrade);
  if (trades.some((trade) => trade === null)) return null;

  const uniqueIds = new Set(trades.map((trade) => trade!.clientOrderId));
  if (uniqueIds.size !== trades.length) return null;

  const revision = Number(value.revision);
  if (trades.length !== Math.min(revision, VIRTUAL_TRADING_MAX_TRADES)) return null;
  for (let index = 0; index < trades.length; index += 1) {
    if (trades[index]!.portfolioRevisionAfter !== revision - index) return null;
  }

  for (const position of [zaps, weth]) {
    const quantity = BigInt(position.quantityRaw);
    const basis = BigInt(position.costBasisRaw);
    if ((quantity === 0n) !== (basis === 0n)) return null;
  }

  const cash = BigInt(value.cashRaw);
  const realized = BigInt(value.realizedPnlRaw);
  const totalBasis = BigInt(zaps.costBasisRaw) + BigInt(weth.costBasisRaw);
  if (cash + totalBasis !== STARTING_CASH_RAW + realized) return null;

  const turnover = BigInt(value.turnoverRaw);
  const retainedTurnover = trades.reduce(
    (total, trade) => total + BigInt(trade!.side === "buy" ? trade!.inputRaw : trade!.outputRaw),
    0n,
  );
  if (
    turnover < retainedTurnover
    || (revision <= VIRTUAL_TRADING_MAX_TRADES && turnover !== retainedTurnover)
  ) return null;
  if (
    revision <= VIRTUAL_TRADING_MAX_TRADES
    && trades.reduce((total, trade) => total + BigInt(trade!.realizedPnlRaw), 0n) !== realized
  ) return null;

  return {
    schemaVersion: VIRTUAL_TRADING_SCHEMA_VERSION,
    formulaVersion: VIRTUAL_TRADING_FORMULA_VERSION,
    revision,
    startCashRaw: value.startCashRaw,
    cashRaw: value.cashRaw,
    positions: { zaps, weth },
    realizedPnlRaw: value.realizedPnlRaw,
    turnoverRaw: value.turnoverRaw,
    trades: trades as VirtualTrade[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function readVirtualPortfolio(storage: Pick<Storage, "getItem">): VirtualPortfolio {
  return parseVirtualPortfolio(storage.getItem(VIRTUAL_TRADING_STORAGE_KEY)) ?? createVirtualPortfolio();
}

export function writeVirtualPortfolio(
  storage: Pick<Storage, "setItem">,
  portfolio: VirtualPortfolio,
): void {
  storage.setItem(VIRTUAL_TRADING_STORAGE_KEY, JSON.stringify(portfolio));
}

function assertFill(fill: VirtualFill, nowMs: number): void {
  if (!CLIENT_ORDER_ID.test(fill.clientOrderId)) {
    throw new VirtualTradingError("The virtual order ID is invalid.");
  }
  if (!isVirtualMarketId(fill.marketId) || (fill.side !== "buy" && fill.side !== "sell")) {
    throw new VirtualTradingError("The virtual market or side is invalid.");
  }
  if (fill.routeId !== routeForVirtualOrder(fill.marketId, fill.side)) {
    throw new VirtualTradingError("The quote route does not match this virtual order.");
  }
  if (!isRawInteger(fill.inputRaw, true) || !isRawInteger(fill.outputRaw, true)) {
    throw new VirtualTradingError("The quote amounts must be positive integers.");
  }
  if (
    fill.chainId !== 4663
    || !isRawInteger(fill.blockNumber, true)
    || !HEX_32.test(fill.blockHash)
    || !isRawInteger(fill.blockTimestamp, true)
  ) {
    throw new VirtualTradingError("The quote is missing canonical Robinhood Chain evidence.");
  }
  if (fill.gasEstimate !== null && !isRawInteger(fill.gasEstimate)) {
    throw new VirtualTradingError("The quote gas evidence is invalid.");
  }
  const quotedAtMs = Date.parse(fill.quotedAt);
  const expiresAtMs = Date.parse(fill.expiresAt);
  if (
    !isIsoDate(fill.quotedAt)
    || !isIsoDate(fill.expiresAt)
    || expiresAtMs - quotedAtMs !== VIRTUAL_QUOTE_TTL_MS
    || expiresAtMs < nowMs
  ) {
    throw new VirtualTradingError("This virtual quote expired. Request a fresh canonical quote.");
  }
}

/**
 * Apply a fill exactly once, against the portfolio revision it was quoted for.
 * Buys spend virtual USDG; sells can only reduce an existing long position.
 */
export function applyVirtualFill(
  portfolio: VirtualPortfolio,
  fill: VirtualFill,
  nowMs = Date.now(),
): VirtualPortfolio {
  assertFill(fill, nowMs);
  if (fill.portfolioRevision !== portfolio.revision) {
    throw new VirtualTradingError("The portfolio changed after this quote. Request a fresh quote.");
  }
  if (portfolio.trades.some((trade) => trade.clientOrderId === fill.clientOrderId)) {
    throw new VirtualTradingError("This virtual fill was already applied.");
  }

  const input = BigInt(fill.inputRaw);
  const output = BigInt(fill.outputRaw);
  const currentCash = BigInt(portfolio.cashRaw);
  const currentPosition = portfolio.positions[fill.marketId];
  const currentQuantity = BigInt(currentPosition.quantityRaw);
  const currentBasis = BigInt(currentPosition.costBasisRaw);

  let nextCash = currentCash;
  let nextQuantity = currentQuantity;
  let nextBasis = currentBasis;
  let releasedBasis = 0n;
  let realizedThisFill = 0n;

  if (fill.side === "buy") {
    if (input > currentCash) {
      throw new VirtualTradingError("This virtual order exceeds available USDG.");
    }
    nextCash -= input;
    nextQuantity += output;
    nextBasis += input;
  } else {
    if (input > currentQuantity) {
      throw new VirtualTradingError("Short selling is disabled; this order exceeds the virtual position.");
    }
    releasedBasis = input === currentQuantity ? currentBasis : (currentBasis * input) / currentQuantity;
    nextQuantity -= input;
    nextBasis -= releasedBasis;
    nextCash += output;
    realizedThisFill = output - releasedBasis;
  }

  const revision = portfolio.revision + 1;
  const trade: VirtualTrade = {
    ...fill,
    portfolioRevisionAfter: revision,
    releasedCostBasisRaw: releasedBasis.toString(),
    realizedPnlRaw: realizedThisFill.toString(),
  };

  return {
    ...portfolio,
    revision,
    cashRaw: nextCash.toString(),
    positions: {
      ...portfolio.positions,
      [fill.marketId]: {
        quantityRaw: nextQuantity.toString(),
        costBasisRaw: nextBasis.toString(),
      },
    },
    realizedPnlRaw: (BigInt(portfolio.realizedPnlRaw) + realizedThisFill).toString(),
    turnoverRaw: (
      BigInt(portfolio.turnoverRaw)
      + (fill.side === "buy" ? input : output)
    ).toString(),
    trades: [trade, ...portfolio.trades].slice(0, VIRTUAL_TRADING_MAX_TRADES),
    updatedAt: fill.quotedAt,
  };
}

export function parseVirtualAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new VirtualTradingError("Enter a positive decimal amount.");
  }
  let raw: bigint;
  try {
    raw = parseUnits(normalized, decimals);
  } catch {
    throw new VirtualTradingError(`Use no more than ${decimals} decimal places.`);
  }
  if (raw <= 0n) throw new VirtualTradingError("Enter an amount greater than zero.");
  return raw;
}

export function formatVirtualAmount(
  raw: string | bigint,
  decimals: number,
  maximumFractionDigits = 4,
): string {
  const value = Number(formatUnits(typeof raw === "bigint" ? raw : BigInt(raw), decimals));
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) < 10 ** -maximumFractionDigits) {
    return value.toExponential(Math.min(maximumFractionDigits, 4));
  }
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

/** Exact decimal text for a form input; never route balances through Number. */
export function formatVirtualInput(raw: string | bigint, decimals: number): string {
  return formatUnits(typeof raw === "bigint" ? raw : BigInt(raw), decimals);
}

export function formatPriceWad(raw: string, maximumFractionDigits = 8): string {
  const value = Number(formatUnits(BigInt(raw), PRICE_WAD_DECIMALS));
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.000001) return value.toExponential(4);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 0,
    maximumFractionDigits,
  });
}

export function virtualFillPriceWad(fill: Pick<VirtualFill, "marketId" | "side" | "inputRaw" | "outputRaw">): bigint {
  const market = VIRTUAL_MARKETS[fill.marketId];
  const tokenRaw = BigInt(fill.side === "buy" ? fill.outputRaw : fill.inputRaw);
  const usdgRaw = BigInt(fill.side === "buy" ? fill.inputRaw : fill.outputRaw);
  if (tokenRaw <= 0n || usdgRaw <= 0n) throw new VirtualTradingError("A fill price requires positive amounts.");
  return (
    usdgRaw
    * 10n ** BigInt(market.decimals + PRICE_WAD_DECIMALS)
    / (tokenRaw * 10n ** BigInt(USDG_DECIMALS))
  );
}

export function calculateVirtualMetrics(
  portfolio: VirtualPortfolio,
  valuation: VirtualPortfolioValuation | null,
): VirtualMetrics {
  const values: Record<VirtualMarketId, string | null> = { zaps: null, weth: null };
  let totalBasis = 0n;
  const hasPosition = (Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[])
    .some((marketId) => BigInt(portfolio.positions[marketId].quantityRaw) > 0n);
  let complete = !hasPosition;

  if (hasPosition && valuation) {
    complete = (
      valuation.portfolioRevision === portfolio.revision
      && (Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[]).every(
        (marketId) => (
          valuation.positions[marketId].inputRaw
          === portfolio.positions[marketId].quantityRaw
        ),
      )
    );
  }

  for (const marketId of Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[]) {
    const position = portfolio.positions[marketId];
    const quantity = BigInt(position.quantityRaw);
    totalBasis += BigInt(position.costBasisRaw);
    if (quantity === 0n) {
      values[marketId] = "0";
      continue;
    }
    const standaloneOutput = valuation?.positions[marketId].outputRaw;
    if (!complete || !standaloneOutput || !isRawInteger(standaloneOutput, true)) {
      values[marketId] = null;
      continue;
    }
    values[marketId] = standaloneOutput;
  }

  const realized = BigInt(portfolio.realizedPnlRaw);

  if (!complete) {
    return {
      status: "unavailable",
      navRaw: null,
      positionValueRaw: values,
      unrealizedPnlRaw: null,
      realizedPnlRaw: realized.toString(),
      totalPnlRaw: null,
      returnBps: null,
      turnoverRaw: portfolio.turnoverRaw,
    };
  }

  const aggregatePositionValue = hasPosition
    ? BigInt(valuation!.portfolioOutputRaw)
    : 0n;
  const nav = BigInt(portfolio.cashRaw) + aggregatePositionValue;
  const unrealized = aggregatePositionValue - totalBasis;
  const totalPnl = nav - BigInt(portfolio.startCashRaw);
  const returnBps = (totalPnl * 10_000n) / BigInt(portfolio.startCashRaw);

  return {
    status: "ready",
    navRaw: nav.toString(),
    positionValueRaw: values,
    unrealizedPnlRaw: unrealized.toString(),
    realizedPnlRaw: realized.toString(),
    totalPnlRaw: totalPnl.toString(),
    returnBps: returnBps.toString(),
    turnoverRaw: portfolio.turnoverRaw,
  };
}
