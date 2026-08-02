"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Glyph } from "@/components/Glyph";
import { ProtocolLogo } from "@/components/ProtocolLogo";
import { trackEvent } from "@/lib/analytics";
import {
  USDG_DECIMALS,
  VIRTUAL_MARKETS,
  VIRTUAL_TRADING_FORMULA_VERSION,
  VIRTUAL_TRADING_MAX_TRADES,
  VIRTUAL_TRADING_STORAGE_KEY,
  applyVirtualFill,
  calculateVirtualMetrics,
  createVirtualPortfolio,
  formatPriceWad,
  formatVirtualAmount,
  formatVirtualInput,
  parseVirtualAmount,
  parseVirtualFill,
  parseVirtualMarketSnapshot,
  parseVirtualPortfolioValuation,
  readVirtualPortfolio,
  virtualFillPriceWad,
  virtualTradeDirectionLabel,
  virtualTradeRequestHref,
  writeVirtualPortfolio,
  type VirtualFill,
  type VirtualMarketId,
  type VirtualMarketSnapshot,
  type VirtualOrderSide,
  type VirtualPortfolio,
  type VirtualPortfolioValuation,
} from "@/lib/virtual-trading";
import {
  VIRTUAL_ASSET_VISUALS,
  VIRTUAL_TRADING_VENUE,
  virtualQuotePath,
  virtualQuotePoolCount,
  virtualQuoteRouteLabel,
  type VirtualQuoteAssetId,
} from "@/lib/virtual-trading-visuals";
import styles from "./virtual-trading.module.css";

type SnapshotState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: VirtualMarketSnapshot; staleSince: string | null };

type ValuationState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: VirtualPortfolioValuation; staleSince: string | null };

const MARKET_IDS = Object.keys(VIRTUAL_MARKETS) as VirtualMarketId[];
const PORTFOLIO_LOCK_NAME = `${VIRTUAL_TRADING_STORAGE_KEY}.write`;

function VirtualAssetMark({
  assetId,
  size = 36,
}: {
  assetId: VirtualQuoteAssetId;
  size?: number;
}): React.JSX.Element {
  const asset = VIRTUAL_ASSET_VISUALS[assetId];

  return (
    <span
      className={styles.assetMark}
      data-asset={assetId}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {asset.imageSrc ? (
        <Image
          src={asset.imageSrc}
          alt=""
          width={size}
          height={size}
          className={styles.assetMarkImage}
          draggable={false}
          unoptimized
        />
      ) : (
        asset.monogram
      )}
    </span>
  );
}

async function withPortfolioLock<T>(work: () => T | Promise<T>): Promise<T> {
  if (navigator.locks) {
    return navigator.locks.request(PORTFOLIO_LOCK_NAME, work);
  }
  return work();
}

function signedVirtual(raw: string | null, suffix = " vUSDG"): string {
  if (raw === null) return "Unavailable";
  const value = BigInt(raw);
  const sign = value > 0n ? "+" : "";
  return `${sign}${formatVirtualAmount(value, USDG_DECIMALS, 2)}${suffix}`;
}

function signedReturn(raw: string | null): string {
  if (raw === null) return "Unavailable";
  const bps = BigInt(raw);
  const sign = bps > 0n ? "+" : "";
  return `${sign}${(Number(bps) / 100).toFixed(2)}%`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function marketMark(snapshot: VirtualMarketSnapshot | null, marketId: VirtualMarketId) {
  return snapshot?.markets.find((market) => market.marketId === marketId) ?? null;
}

function valuationMatchesPortfolio(
  valuation: VirtualPortfolioValuation,
  portfolio: VirtualPortfolio,
): boolean {
  return (
    valuation.portfolioRevision === portfolio.revision
    && valuation.positions.zaps.inputRaw === portfolio.positions.zaps.quantityRaw
    && valuation.positions.weth.inputRaw === portfolio.positions.weth.quantityRaw
  );
}

function quoteOutputLabel(fill: VirtualFill): string {
  const market = VIRTUAL_MARKETS[fill.marketId];
  return fill.side === "buy"
    ? `${formatVirtualAmount(fill.outputRaw, market.decimals, 8)} ${market.symbol}`
    : `${formatVirtualAmount(fill.outputRaw, USDG_DECIMALS, 2)} virtual USDG`;
}

function quoteInputLabel(fill: VirtualFill): string {
  const market = VIRTUAL_MARKETS[fill.marketId];
  return fill.side === "buy"
    ? `${formatVirtualAmount(fill.inputRaw, USDG_DECIMALS, 2)} virtual USDG`
    : `${formatVirtualAmount(fill.inputRaw, market.decimals, 8)} ${market.symbol}`;
}

export function VirtualTradingDesk(): React.JSX.Element {
  const [portfolio, setPortfolio] = useState<VirtualPortfolio | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: "loading" });
  const [valuation, setValuation] = useState<ValuationState>({ status: "loading" });
  const [marketId, setMarketId] = useState<VirtualMarketId>("zaps");
  const [side, setSide] = useState<VirtualOrderSide>("buy");
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<VirtualFill | null>(null);
  const [busy, setBusy] = useState<"quote" | "fill" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestSequence = useRef(0);
  const valuationSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setPortfolio(readVirtualPortfolio(window.localStorage));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const syncPortfolio = (event: StorageEvent): void => {
      if (
        event.storageArea !== window.localStorage
        || (event.key !== null && event.key !== VIRTUAL_TRADING_STORAGE_KEY)
      ) return;
      setPortfolio(readVirtualPortfolio(window.localStorage));
      setValuation({ status: "loading" });
      setQuote(null);
      setError("");
      setNotice("Virtual ledger updated in another tab.");
    };
    window.addEventListener("storage", syncPortfolio);
    return () => window.removeEventListener("storage", syncPortfolio);
  }, []);

  const loadMarkets = useCallback(async (): Promise<void> => {
    const mine = ++requestSequence.current;
    try {
      const response = await fetch("/api/virtual-trading/markets", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = parseVirtualMarketSnapshot(await response.json());
      if (!parsed) throw new Error("Invalid market snapshot.");
      if (mine !== requestSequence.current) return;
      setSnapshot({ status: "ready", data: parsed, staleSince: null });
    } catch {
      if (mine !== requestSequence.current) return;
      setSnapshot((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadMarkets();
    });
    const timer = window.setInterval(() => void loadMarkets(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [loadMarkets]);

  const loadValuation = useCallback(async (currentPortfolio: VirtualPortfolio): Promise<void> => {
    const mine = ++valuationSequence.current;
    try {
      const response = await fetch("/api/virtual-trading/valuation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          zapsRaw: currentPortfolio.positions.zaps.quantityRaw,
          wethRaw: currentPortfolio.positions.weth.quantityRaw,
          portfolioRevision: currentPortfolio.revision,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const parsed = parseVirtualPortfolioValuation(await response.json());
      if (!parsed || !valuationMatchesPortfolio(parsed, currentPortfolio)) {
        throw new Error("Invalid portfolio valuation.");
      }
      if (mine !== valuationSequence.current) return;
      setValuation({ status: "ready", data: parsed, staleSince: null });
    } catch {
      if (mine !== valuationSequence.current) return;
      setValuation((current) =>
        current.status === "ready" && valuationMatchesPortfolio(current.data, currentPortfolio)
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    }
  }, []);

  useEffect(() => {
    if (!portfolio) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadValuation(portfolio);
    });
    const timer = window.setInterval(() => void loadValuation(portfolio), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      valuationSequence.current += 1;
    };
  }, [loadValuation, portfolio]);

  const market = VIRTUAL_MARKETS[marketId];
  const readySnapshot = snapshot.status === "ready" ? snapshot.data : null;
  const readyValuation = valuation.status === "ready" && portfolio
    && valuationMatchesPortfolio(valuation.data, portfolio)
    ? valuation.data
    : null;
  const metrics = useMemo(
    () => portfolio ? calculateVirtualMetrics(portfolio, readyValuation) : null,
    [portfolio, readyValuation],
  );

  let inputRaw: bigint | null = null;
  let inputIssue = "";
  try {
    inputRaw = parseVirtualAmount(amount, side === "buy" ? USDG_DECIMALS : market.decimals);
    if (portfolio) {
      const available = side === "buy"
        ? BigInt(portfolio.cashRaw)
        : BigInt(portfolio.positions[marketId].quantityRaw);
      if (inputRaw > available) {
        inputIssue = side === "buy"
          ? "Amount exceeds available virtual USDG."
          : "Short selling is disabled; amount exceeds this position.";
      }
    }
  } catch (cause) {
    inputIssue = cause instanceof Error ? cause.message : "Enter a valid amount.";
  }

  const quoteMatchesOrder = Boolean(
    quote
    && portfolio
    && inputRaw
    && quote.marketId === marketId
    && quote.side === side
    && quote.inputRaw === inputRaw.toString()
    && quote.portfolioRevision === portfolio.revision,
  );

  const requestQuote = useCallback(async (): Promise<void> => {
    if (!portfolio || !inputRaw || inputIssue) return;
    const clientOrderId = `paper-${window.crypto.randomUUID()}`;
    setBusy("quote");
    setError("");
    setNotice("");
    setQuote(null);
    try {
      const response = await fetch("/api/virtual-trading/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          marketId,
          side,
          inputRaw: inputRaw.toString(),
          clientOrderId,
          portfolioRevision: portfolio.revision,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object"
          && body !== null
          && "error" in body
          && typeof body.error === "string"
            ? body.error
            : "The canonical quote is unavailable.";
        throw new Error(message);
      }
      const parsed = parseVirtualFill(body);
      if (
        !parsed
        || parsed.clientOrderId !== clientOrderId
        || parsed.portfolioRevision !== portfolio.revision
        || parsed.marketId !== marketId
        || parsed.side !== side
        || parsed.inputRaw !== inputRaw.toString()
      ) {
        throw new Error("The quote response did not match this virtual order.");
      }
      setQuote(parsed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The canonical quote is unavailable.");
    } finally {
      setBusy(null);
    }
  }, [inputIssue, inputRaw, marketId, portfolio, side]);

  const placeVirtualTrade = useCallback(async (): Promise<void> => {
    if (!portfolio || !quote || !quoteMatchesOrder) return;
    setBusy("fill");
    setError("");
    setNotice("");
    try {
      const next = await withPortfolioLock(() => {
        const latest = readVirtualPortfolio(window.localStorage);
        const updated = applyVirtualFill(latest, quote);
        writeVirtualPortfolio(window.localStorage, updated);
        return updated;
      });
      setPortfolio(next);
      setValuation({ status: "loading" });
      setNotice(
        `${quote.side === "buy" ? "Bought" : "Sold"} ${VIRTUAL_MARKETS[quote.marketId].symbol} in the local practice ledger.`,
      );
      trackEvent("virtual_trade_filled", {
        route: quote.routeId,
        mode: quote.side,
      });
      setQuote(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The virtual fill could not be applied.");
    } finally {
      setBusy(null);
    }
  }, [portfolio, quote, quoteMatchesOrder]);

  const useAvailable = useCallback((): void => {
    if (!portfolio) return;
    const raw = side === "buy"
      ? portfolio.cashRaw
      : portfolio.positions[marketId].quantityRaw;
    setAmount(formatVirtualInput(raw, side === "buy" ? USDG_DECIMALS : market.decimals));
    setError("");
    setNotice("");
  }, [market.decimals, marketId, portfolio, side]);

  const resetPortfolio = useCallback(async (): Promise<void> => {
    if (!window.confirm("Reset this device's virtual portfolio and erase its local trade history?")) return;
    const next = await withPortfolioLock(() => {
      const fresh = createVirtualPortfolio();
      writeVirtualPortfolio(window.localStorage, fresh);
      return fresh;
    });
    setPortfolio(next);
    setValuation({ status: "loading" });
    setQuote(null);
    setError("");
    setNotice("Virtual portfolio reset to 10,000 virtual USDG.");
  }, []);

  const exportLedger = useCallback((): void => {
    if (!portfolio) return;
    const payload = JSON.stringify(
      {
        kind: "openzaps-virtual-practice",
        exportedAt: new Date().toISOString(),
        portfolio,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openzaps-virtual-practice-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [portfolio]);

  if (!portfolio || !metrics) {
    return (
      <section className={styles.loadingPanel} aria-live="polite">
        <span className={styles.loadingPulse} aria-hidden />
        Loading this device&apos;s virtual ledger…
      </section>
    );
  }

  const totalPnlSign = metrics.totalPnlRaw === null ? "flat" : BigInt(metrics.totalPnlRaw) > 0n
    ? "up"
    : BigInt(metrics.totalPnlRaw) < 0n ? "down" : "flat";
  const availableRaw = side === "buy" ? portfolio.cashRaw : portfolio.positions[marketId].quantityRaw;
  const availableDecimals = side === "buy" ? USDG_DECIMALS : market.decimals;
  const availableSymbol = side === "buy" ? "virtual USDG" : market.symbol;
  const hasOpenPositions = MARKET_IDS.some(
    (id) => BigInt(portfolio.positions[id].quantityRaw) > 0n,
  );
  const routePath = virtualQuotePath(marketId, side);
  const routePoolCount = virtualQuotePoolCount(marketId);
  const latestTrade = portfolio.trades[0] ?? null;
  const latestDirection = latestTrade
    ? virtualTradeDirectionLabel(latestTrade.marketId, latestTrade.side)
    : null;
  const requestHref = latestTrade
    ? virtualTradeRequestHref(latestTrade.marketId, latestTrade.side)
    : null;

  return (
    <section className={styles.desk} aria-label="Virtual trading practice desk">
      <div className={styles.sourceBar}>
        <div className={styles.sourceSummary}>
          <span className={styles.sourceState} data-state={snapshot.status}>
            <i aria-hidden />
            {snapshot.status === "loading"
              ? "Reading canonical markets"
              : snapshot.status === "unavailable"
                ? "Canonical markets unavailable"
                : snapshot.staleSince
                  ? "Showing last verified marks"
                  : "Canonical markets verified"}
          </span>
          <span className={styles.sourceVenue}>
            <ProtocolLogo protocol={VIRTUAL_TRADING_VENUE.protocol} size={18} />
            <strong>{VIRTUAL_TRADING_VENUE.name}</strong>
            <span aria-hidden>·</span>
            {VIRTUAL_TRADING_VENUE.network} {VIRTUAL_TRADING_VENUE.chainId}
          </span>
        </div>
        {readySnapshot ? (
          <span className={styles.blockEvidence}>
            Block <strong>{Number(readySnapshot.blockNumber).toLocaleString("en-US")}</strong>
            <code title={readySnapshot.blockHash}>{shortHash(readySnapshot.blockHash)}</code>
            <time dateTime={new Date(Number(readySnapshot.blockTimestamp) * 1000).toISOString()}>
              {new Date(Number(readySnapshot.blockTimestamp) * 1000).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </span>
        ) : (
          <button className={styles.inlineButton} type="button" onClick={() => void loadMarkets()}>
            Retry
          </button>
        )}
      </div>

      {snapshot.status === "ready" && snapshot.staleSince ? (
        <p className={styles.stale} role="status">
          Live refreshes have failed since {new Date(snapshot.staleSince).toLocaleTimeString("en-US")}. Positions
          still show the last verified reference marks.
        </p>
      ) : null}

      {valuation.status === "ready" && valuation.staleSince ? (
        <p className={styles.stale} role="status">
          Portfolio refreshes have failed since {new Date(valuation.staleSince).toLocaleTimeString("en-US")}.
          NAV still uses the last whole-portfolio quote for revision {portfolio.revision}.
        </p>
      ) : null}

      <div className={styles.metrics} aria-label="Virtual portfolio summary">
        <article>
          <span>Net asset value</span>
          <strong>{metrics.navRaw === null ? "Unavailable" : `${formatVirtualAmount(metrics.navRaw, 6, 2)} vUSDG`}</strong>
          <small>
            {metrics.navRaw === null
              ? "Awaiting deterministic joint exit quote"
              : hasOpenPositions && readyValuation
                ? `Cash + joint Uniswap v4 exit · block ${Number(readyValuation.blockNumber).toLocaleString("en-US")}`
                : "Cash only · no open positions"}
          </small>
        </article>
        <article>
          <span>Session PnL</span>
          <strong data-sign={totalPnlSign}>{signedVirtual(metrics.totalPnlRaw)}</strong>
          <small>{signedReturn(metrics.returnBps)} from 10,000 vUSDG</small>
        </article>
        <article>
          <span>Buying power</span>
          <strong>{formatVirtualAmount(portfolio.cashRaw, USDG_DECIMALS, 2)} vUSDG</strong>
          <small>No deposits · no withdrawals</small>
        </article>
        <article>
          <span>Turnover</span>
          <strong>{formatVirtualAmount(metrics.turnoverRaw, USDG_DECIMALS, 2)} vUSDG</strong>
          <small>{portfolio.revision} local fill{portfolio.revision === 1 ? "" : "s"}</small>
        </article>
      </div>

      <div className={styles.workspace}>
        <div className={styles.marketColumn}>
          <header className={styles.panelHead}>
            <div>
              <span className={styles.panelLabel}>MARKETS · ROBINHOOD CHAIN 4663</span>
              <h2>Canonical sample sell marks</h2>
            </div>
            <button className={styles.inlineButton} type="button" onClick={() => void loadMarkets()}>
              Refresh
            </button>
          </header>

          <div className={styles.marketGrid}>
            {MARKET_IDS.map((id) => {
              const item = VIRTUAL_MARKETS[id];
              const itemMark = marketMark(readySnapshot, id);
              const position = portfolio.positions[id];
              const value = metrics.positionValueRaw[id];
              return (
                <button
                  className={styles.marketCard}
                  data-selected={marketId === id}
                  key={id}
                  type="button"
                  onClick={() => {
                    setMarketId(id);
                    setError("");
                    setNotice("");
                  }}
                  aria-pressed={marketId === id}
                >
                  <span className={styles.marketIdentity}>
                    <VirtualAssetMark assetId={id} size={38} />
                    <span className={styles.marketIdentityCopy}>
                      <strong>{item.symbol}</strong>
                      <small>{item.name}</small>
                    </span>
                    <span className={styles.marketVenue}>
                      <ProtocolLogo protocol={VIRTUAL_TRADING_VENUE.protocol} size={18} />
                      <span>{VIRTUAL_TRADING_VENUE.name}</span>
                    </span>
                  </span>
                  <span className={styles.marketPrice}>
                    <strong>{itemMark ? formatPriceWad(itemMark.priceWad, id === "zaps" ? 10 : 2) : "Unavailable"}</strong>
                    <small>virtual USDG · exact-input sample mark</small>
                  </span>
                  <span className={styles.marketHolding}>
                    <small>Position</small>
                    <strong>{formatVirtualAmount(position.quantityRaw, item.decimals, 6)} {item.symbol}</strong>
                    <em>{value === null ? "Unmarked" : `${formatVirtualAmount(value, 6, 2)} vUSDG`}</em>
                  </span>
                </button>
              );
            })}
          </div>

          <section className={styles.positions} aria-labelledby="positions-title">
            <header className={styles.panelHead}>
              <div>
                <span className={styles.panelLabel}>PORTFOLIO · LONG ONLY</span>
                <h2 id="positions-title">Virtual positions</h2>
              </div>
              <span className={styles.revision}>REV {portfolio.revision}</span>
            </header>
            <div className={styles.tableScroll}>
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Quantity</th>
                    <th>Cost basis</th>
                    <th>Standalone exit</th>
                    <th>Unrealized</th>
                  </tr>
                </thead>
                <tbody>
                  {MARKET_IDS.map((id) => {
                    const item = VIRTUAL_MARKETS[id];
                    const position = portfolio.positions[id];
                    const value = metrics.positionValueRaw[id];
                    const unrealized = value === null
                      ? null
                      : (BigInt(value) - BigInt(position.costBasisRaw)).toString();
                    const sign = unrealized === null ? "flat" : BigInt(unrealized) > 0n
                      ? "up"
                      : BigInt(unrealized) < 0n ? "down" : "flat";
                    return (
                      <tr key={id}>
                        <td><strong>{item.symbol}</strong><small>{item.name}</small></td>
                        <td>{formatVirtualAmount(position.quantityRaw, item.decimals, 8)}</td>
                        <td>{formatVirtualAmount(position.costBasisRaw, 6, 2)} vUSDG</td>
                        <td>{value === null ? "Unavailable" : `${formatVirtualAmount(value, 6, 2)} vUSDG`}</td>
                        <td data-sign={sign}>{signedVirtual(unrealized)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className={styles.orderPanel} aria-labelledby="order-title">
          <header>
            <span className={styles.panelLabel}>EXACT INPUT · VIRTUAL FILL</span>
            <h2 id="order-title">Practice order</h2>
          </header>

          <div className={styles.segmented} aria-label="Order side">
            <button type="button" data-active={side === "buy"} onClick={() => setSide("buy")}>Buy</button>
            <button type="button" data-active={side === "sell"} onClick={() => setSide("sell")}>Sell</button>
          </div>

          <label className={styles.field}>
            <span>Market</span>
            <select value={marketId} onChange={(event) => setMarketId(event.target.value as VirtualMarketId)}>
              {MARKET_IDS.map((id) => (
                <option value={id} key={id}>{VIRTUAL_MARKETS[id].symbol} / USDG</option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>{side === "buy" ? "Virtual USDG to spend" : `${market.symbol} to sell`}</span>
            <div className={styles.amountControl}>
              <input
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-invalid={Boolean(inputIssue)}
              />
              <button type="button" onClick={useAvailable}>MAX</button>
            </div>
            <small>
              Available {formatVirtualAmount(availableRaw, availableDecimals, 8)} {availableSymbol}
            </small>
          </label>
          {inputIssue ? <p className={styles.fieldError}>{inputIssue}</p> : null}

          <div className={styles.routeBox}>
            <div className={styles.routeHeading}>
              <span className={styles.routeLabel}>Execution route</span>
              <span className={styles.routeVenue}>
                <ProtocolLogo protocol={VIRTUAL_TRADING_VENUE.protocol} size={18} />
                <strong>{VIRTUAL_TRADING_VENUE.name}</strong>
              </span>
            </div>
            <div
              className={styles.routeFlow}
              role="img"
              aria-label={virtualQuoteRouteLabel(marketId, side)}
            >
              {routePath.map((assetId, index) => {
                const asset = VIRTUAL_ASSET_VISUALS[assetId];
                return (
                  <span className={styles.routeStep} key={assetId}>
                    {index > 0 ? <span className={styles.routeArrow} aria-hidden>→</span> : null}
                    <span className={styles.routeAsset}>
                      <VirtualAssetMark assetId={assetId} size={24} />
                      <strong>{asset.symbol}</strong>
                    </span>
                  </span>
                );
              })}
            </div>
            <div className={styles.routeSummary}>
              <strong>
                {routePoolCount} pinned pool{routePoolCount === 1 ? "" : "s"}
              </strong>
              <span>
                {marketId === "zaps"
                  ? "The 0xZAPS leg uses its Clanker-hooked v4 pool."
                  : "Direct hookless USDG / aeWETH v4 pool."}
              </span>
            </div>
            <div className={styles.routeAudit}>
              <code title={side === "buy" ? market.buyRouteId : market.sellRouteId}>
                {side === "buy" ? market.buyRouteId : market.sellRouteId}
              </code>
              <small>Read-only eth_call · exact input · the virtual ledger mirrors the USDG edge</small>
            </div>
          </div>

          {quoteMatchesOrder && quote ? (
            <section className={styles.quoteCard} aria-label="Canonical quote">
              <div>
                <span>You give</span>
                <strong>{quoteInputLabel(quote)}</strong>
              </div>
              <div>
                <span>Virtual fill</span>
                <strong>{quoteOutputLabel(quote)}</strong>
              </div>
              <div>
                <span>Effective price</span>
                <strong>{formatPriceWad(virtualFillPriceWad(quote).toString(), quote.marketId === "zaps" ? 10 : 2)} vUSDG</strong>
              </div>
              <footer>
                <span>Canonical block {Number(quote.blockNumber).toLocaleString("en-US")}</span>
                <span>Expires {new Date(quote.expiresAt).toLocaleTimeString("en-US")}</span>
              </footer>
            </section>
          ) : null}

          <div className={styles.orderActions}>
            <button
              className="btn btnGhost"
              data-busy={busy === "quote"}
              disabled={Boolean(inputIssue) || busy !== null}
              type="button"
              onClick={() => void requestQuote()}
            >
              {busy === "quote" ? "Quoting…" : quoteMatchesOrder ? "Refresh quote" : "Get canonical quote"}
            </button>
            <button
              className="btn btnPrimary"
              data-busy={busy === "fill"}
              disabled={!quoteMatchesOrder || busy !== null}
              type="button"
              onClick={() => void placeVirtualTrade()}
            >
              {busy === "fill" ? "Recording…" : "Place virtual trade"}
            </button>
          </div>

          <div className={styles.messages} aria-live="polite">
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            {notice ? <p className={styles.notice}>{notice}</p> : null}
          </div>

          <p className={styles.noWallet}>
            <Glyph name="shield" />
            This action writes only to <code>localStorage</code>. It cannot open a wallet prompt.
          </p>
        </aside>
      </div>

      {latestTrade && requestHref ? (
        <section className={styles.authorityHandoff} aria-labelledby="authority-handoff-title">
          <div>
            <span className={styles.panelLabel}>PAPER ROUTE → AUTHORITY MAP</span>
            <h2 id="authority-handoff-title">
              Turn this paper route into a bounded authority map.
            </h2>
            <p>
              Start a human-reviewed brief for the {latestDirection} route. The
              handoff carries only its public route and direction—never your
              amount, PnL, order ID, block evidence, or browser ledger.
            </p>
          </div>
          <div className={styles.authorityAction}>
            <Link
              className="btn btnPrimary"
              href={requestHref}
              data-analytics-event="request_zap_clicked"
              data-analytics-cta="request_zap"
              data-analytics-content="virtual_trading"
            >
              Request the authority map
            </Link>
            <small>Human reviewed · pre-audit · no automatic deployment</small>
          </div>
        </section>
      ) : null}

      <section className={styles.history} aria-labelledby="history-title">
        <header className={styles.panelHead}>
          <div>
            <span className={styles.panelLabel}>DEVICE LEDGER · LAST {VIRTUAL_TRADING_MAX_TRADES}</span>
            <h2 id="history-title">Virtual fill history</h2>
          </div>
          <div className={styles.historyActions}>
            <button type="button" className={styles.inlineButton} onClick={exportLedger} disabled={portfolio.trades.length === 0}>
              Export JSON
            </button>
            <button type="button" className={styles.resetButton} onClick={() => void resetPortfolio()}>
              Reset practice
            </button>
          </div>
        </header>
        {portfolio.trades.length === 0 ? (
          <div className={styles.emptyHistory}>
            <Glyph name="bars" />
            <strong>No virtual fills yet.</strong>
            <span>Choose a market, request a canonical quote, and place a paper trade.</span>
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Market</th>
                  <th>Input</th>
                  <th>Virtual fill</th>
                  <th>Price</th>
                  <th>Canonical block</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.trades.map((trade) => (
                  <tr key={trade.clientOrderId}>
                    <td><time dateTime={trade.quotedAt}>{new Date(trade.quotedAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}</time></td>
                    <td><span className={styles.sideTag} data-side={trade.side}>{trade.side}</span></td>
                    <td><strong>{VIRTUAL_MARKETS[trade.marketId].symbol}</strong></td>
                    <td>{quoteInputLabel(trade)}</td>
                    <td>{quoteOutputLabel(trade)}</td>
                    <td>{formatPriceWad(virtualFillPriceWad(trade).toString(), trade.marketId === "zaps" ? 10 : 2)} vUSDG</td>
                    <td><span>{Number(trade.blockNumber).toLocaleString("en-US")}</span><code title={trade.blockHash}>{shortHash(trade.blockHash)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className={styles.ledgerFoot}>
          <span>Schema {portfolio.schemaVersion}</span>
          <span>Formula {VIRTUAL_TRADING_FORMULA_VERSION}</span>
          <span>Browser-local · not a public score</span>
        </footer>
      </section>
    </section>
  );
}
