"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { JsonLd } from "@/components/JsonLd";
import { CHAIN } from "@/lib/config";
import type { BotState } from "@/app/api/bot/state/route";
import styles from "./bot.module.css";

interface LaunchRow {
  token: string;
  name: string;
  symbol: string;
  block: number;
  txHash: string;
  realBuyers: number;
  ageMinutes: number;
  dex: {
    vol24h: number;
    liq: number;
    fdv: number;
    price: string;
    buys: number;
    sells: number;
    created: number;
    url: string;
    priceChange24h: number;
  } | null;
  score: number;
  decision: "BUY" | "SKIP";
  reason: string;
}

const MONITOR_REFRESH_MS = 30_000;
const STATE_REFRESH_MS = 60_000;

const STATUS_MAP = {
  BUY: { className: styles.statusBuy, label: "BUY" },
  SKIP: { className: styles.statusSkip, label: "SKIP" },
} as const;

function fmtNum(n: number, decimals = 2): string {
  if (n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(decimals)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(decimals)}K`;
  return `$${n.toFixed(decimals)}`;
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export default function BotPage(): React.JSX.Element {
  const [launches, setLaunches] = useState<LaunchRow[]>([]);
  const [state, setState] = useState<BotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "buy" | "live">("all");
  const [selectedLaunch, setSelectedLaunch] = useState<LaunchRow | null>(null);

  const fetchLaunches = useCallback(async () => {
    try {
      const r = await fetch("/api/bot/launches");
      const d = await r.json();
      if (d.launches) {
        setLaunches(d.launches);
        setError(null);
      } else {
        setError(d.error || "No data");
      }
    } catch {
      setError("Failed to fetch launch data");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const r = await fetch("/api/bot/state");
      const d = await r.json();
      if (!d.error) setState(d);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    fetchLaunches();
    fetchState();
    const lInt = setInterval(fetchLaunches, MONITOR_REFRESH_MS);
    const sInt = setInterval(fetchState, STATE_REFRESH_MS);
    return () => { clearInterval(lInt); clearInterval(sInt); };
  }, [fetchLaunches, fetchState]);

  const filtered = useMemo(() => {
    if (filter === "buy") return launches.filter(l => l.decision === "BUY");
    return launches;
  }, [launches, filter]);

  const stats = useMemo(() => ({
    total: launches.length,
    buys: launches.filter(l => l.decision === "BUY").length,
    withVolume: launches.filter(l => l.dex && l.dex.vol24h > 0).length,
    avgBuyers: launches.length > 0 ? Math.round(launches.reduce((s, l) => s + l.realBuyers, 0) / launches.length) : 0,
    highestScore: launches.reduce((max, l) => l.score > max ? l.score : max, 0),
  }), [launches]);

  return (
    <main className={styles.page} id="main" data-screen-label="ZapBot">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            Uniswap Instant Launch Bot · {CHAIN.name}
          </p>
          <h1>ZapBot Dashboard</h1>
          <p className={styles.subtitle}>
            Monitor new token launches, score them in real-time, and manage automated buys.
            {stats.buys > 0 && ` ${stats.buys} recent signals detected.`}
          </p>
        </div>
        <div className={styles.headerStats}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Launches</span>
            <span className={styles.statValue}>{stats.total}</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Buy Signals</span>
            <span className={styles.statValue} data-tone="buy">{stats.buys}</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Avg Buyers</span>
            <span className={styles.statValue}>{stats.avgBuyers}</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Best Score</span>
            <span className={styles.statValue}>{stats.highestScore}/10</span>
          </div>
        </div>
      </section>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <section className={styles.filterBar}>
        <div className={styles.filterTabs}>
          {(["all", "buy"] as const).map(tab => (
            <button
              key={tab}
              className={`${styles.filterTab} ${filter === tab ? styles.filterTabActive : ""}`}
              onClick={() => setFilter(tab)}
            >
              {tab === "all" ? "All Launches" : "Buy Signals"}
              {tab === "buy" && stats.buys > 0 && (
                <span className={styles.badge}>{stats.buys}</span>
              )}
            </button>
          ))}
        </div>
        <div className={styles.filterInfo}>
          {loading ? "Loading…" : error ? <span className={styles.errorText}>{error}</span> : `${launches.length} launches shown`}
        </div>
      </section>

      {/* ── Main: launch table ──────────────────────────────────────────── */}
      <section className={styles.tableSection}>
        <div className={styles.table}>
          {/* Header */}
          <div className={styles.tableRow} data-header="true">
            <span className={styles.colToken}>Token</span>
            <span className={styles.colAge}>Age</span>
            <span className={styles.colBuyers}>Buyers</span>
            <span className={styles.colVol}>24h Vol</span>
            <span className={styles.colLiq}>Liq</span>
            <span className={styles.colFdv}>FDV</span>
            <span className={styles.colScore}>Score</span>
            <span className={styles.colAction}>Decision</span>
          </div>

          {/* Rows */}
          {filtered.map((launch) => {
            const stat = STATUS_MAP[launch.decision];
            return (
              <div
                key={launch.txHash}
                className={`${styles.tableRow} ${selectedLaunch?.txHash === launch.txHash ? styles.tableRowSelected : ""}`}
                onClick={() => setSelectedLaunch(selectedLaunch?.txHash === launch.txHash ? null : launch)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedLaunch(launch); }}
              >
                <span className={styles.colToken}>
                  <span className={styles.tokenSymbol}>${launch.symbol}</span>
                  <span className={styles.tokenName}>{launch.name}</span>
                </span>
                <span className={styles.colAge}>{timeAgo(launch.ageMinutes)}</span>
                <span className={styles.colBuyers}>{launch.realBuyers}</span>
                <span className={`${styles.colVol} ${styles.monoCell}`}>
                  {launch.dex ? fmtNum(launch.dex.vol24h) : "—"}
                </span>
                <span className={`${styles.colLiq} ${styles.monoCell}`}>
                  {launch.dex ? fmtNum(launch.dex.liq) : "—"}
                </span>
                <span className={`${styles.colFdv} ${styles.monoCell}`}>
                  {launch.dex ? fmtNum(launch.dex.fdv, 0) : "—"}
                </span>
                <span className={styles.colScore}>
                  <span className={`${styles.scoreBadge} ${launch.score >= 6 ? styles.scoreBuy : styles.scoreSkip}`}>
                    {launch.score}
                  </span>
                </span>
                <span className={styles.colAction}>
                  <span className={`${styles.decisionBadge} ${stat.className}`}>
                    {stat.label}
                  </span>
                </span>
              </div>
            );
          })}

          {filtered.length === 0 && !loading && (
            <div className={styles.emptyRow}>
              <span>No launches match the current filter.</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Launch detail panel ─────────────────────────────────────────── */}
      {selectedLaunch && (
        <section className={styles.detailPanel}>
          <header className={styles.detailHeader}>
            <div>
              <h2>${selectedLaunch.symbol} — {selectedLaunch.name}</h2>
              <p className={styles.detailMeta}>
                Block {selectedLaunch.block.toLocaleString()} · {timeAgo(selectedLaunch.ageMinutes)} · {selectedLaunch.realBuyers} real buyers · Score {selectedLaunch.score}/10
              </p>
            </div>
            <button className={styles.closeBtn} onClick={() => setSelectedLaunch(null)} aria-label="Close detail">
              ✕
            </button>
          </header>

          <div className={styles.detailGrid}>
            <div className={styles.detailCard}>
              <h3>Token</h3>
              <div className={styles.detailRow}>
                <span>Address</span>
                <a href={`${CHAIN.explorer}/address/${selectedLaunch.token}`} target="_blank" rel="noreferrer" className={styles.mono}>
                  {fmtAddr(selectedLaunch.token)} ↗
                </a>
              </div>
              <div className={styles.detailRow}>
                <span>Transaction</span>
                <a href={`${CHAIN.explorer}/tx/${selectedLaunch.txHash}`} target="_blank" rel="noreferrer" className={styles.mono}>
                  {fmtAddr(selectedLaunch.txHash)} ↗
                </a>
              </div>
              <div className={styles.detailRow}>
                <span>Decision</span>
                <span className={`${styles.decisionBadge} ${STATUS_MAP[selectedLaunch.decision].className}`}>
                  {STATUS_MAP[selectedLaunch.decision].label} — {selectedLaunch.reason}
                </span>
              </div>
            </div>

            {selectedLaunch.dex && (
              <div className={styles.detailCard}>
                <h3>Market Data</h3>
                <div className={styles.detailRow}>
                  <span>24h Volume</span>
                  <span>{fmtNum(selectedLaunch.dex.vol24h)}</span>
                </div>
                <div className={styles.detailRow}>
                  <span>Liquidity</span>
                  <span>{fmtNum(selectedLaunch.dex.liq)}</span>
                </div>
                <div className={styles.detailRow}>
                  <span>FDV</span>
                  <span>{fmtNum(selectedLaunch.dex.fdv, 0)}</span>
                </div>
                <div className={styles.detailRow}>
                  <span>Price</span>
                  <span className={styles.mono}>{selectedLaunch.dex.price}</span>
                </div>
                <div className={styles.detailRow}>
                  <span>24h Change</span>
                  <span style={{ color: selectedLaunch.dex.priceChange24h >= 0 ? "var(--ok)" : "var(--danger)" }}>
                    {selectedLaunch.dex.priceChange24h > 0 ? "+" : ""}{selectedLaunch.dex.priceChange24h}%
                  </span>
                </div>
                <div className={styles.detailRow}>
                  <span>Transactions</span>
                  <span>{selectedLaunch.dex.buys} buy / {selectedLaunch.dex.sells} sell</span>
                </div>
                <a href={selectedLaunch.dex.url} target="_blank" rel="noreferrer" className={styles.dexLink}>
                  View on DexScreener ↗
                </a>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Bot config panel ─────────────────────────────────────────────── */}
      <section className={styles.configSection}>
        <header className={styles.configHeader}>
          <h2>Bot Configuration</h2>
          {state && (
            <span className={styles.configStatus}>
              <span className={styles.statusDot} aria-hidden />
              {state.positions.filter(p => p.status === "ACTIVE").length} active positions · Dry run mode
            </span>
          )}
        </header>

        <div className={styles.configGrid}>
          {state && (
            <>
              <div className={styles.configCard}>
                <h3>Buy Parameters</h3>
                <div className={styles.configRow}>
                  <span>Max ETH per buy</span>
                  <span className={styles.mono}>{state.config.maxEthPerBuy} ETH</span>
                </div>
                <div className={styles.configRow}>
                  <span>Slippage</span>
                  <span className={styles.mono}>{state.config.slippageBps / 100}%</span>
                </div>
                <div className={styles.configRow}>
                  <span>Max positions</span>
                  <span className={styles.mono}>{state.config.maxConcurrent}</span>
                </div>
                <div className={styles.configRow}>
                  <span>Stop loss</span>
                  <span className={styles.mono}>-{state.config.stopLossPercent}%</span>
                </div>
                <div className={styles.configRow}>
                  <span>Max hold</span>
                  <span className={styles.mono}>{state.config.maxHoldDays} days</span>
                </div>
              </div>

              <div className={styles.configCard}>
                <h3>Scoring Engine</h3>
                <div className={styles.configRow}>
                  <span>Min real buyers</span>
                  <span className={styles.mono}>{state.config.minRealBuyers}</span>
                </div>
                <div className={styles.configRow}>
                  <span>Scoring window</span>
                  <span className={styles.mono}>{state.config.scoringWindowBlocks} blocks</span>
                </div>
                <div className={styles.configRow}>
                  <span>Wait before score</span>
                  <span className={styles.mono}>{state.config.waitBlocksBeforeScore} blocks</span>
                </div>
              </div>

              <div className={styles.configCard} data-wide="true">
                <h3>Stats</h3>
                <div className={styles.configRow}>
                  <span>Total launches seen</span>
                  <span className={styles.mono}>{state.stats.totalSeen.toLocaleString()}</span>
                </div>
                <div className={styles.configRow}>
                  <span>Total bought</span>
                  <span className={styles.mono}>{state.stats.totalBought}</span>
                </div>
                <div className={styles.configRow}>
                  <span>Realized PnL</span>
                  <span className={styles.mono}>{state.stats.realizedPnlEth >= 0 ? "+" : ""}{state.stats.realizedPnlEth} ETH</span>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className={styles.cta}>
        <h3>Run the bot</h3>
        <p>Execute the scoring engine and optional live buys with your own wallet on Robinhood Chain.</p>
        <div className={styles.ctaActions}>
          <code className={styles.codeBlock}>
            BOT_PRIVATE_KEY=0x… BOT_MAX_ETH_PER_BUY=0.02 node scripts/instant-launch-bot.mjs --live
          </code>
          <a
            className={styles.ctaBtn}
            href="https://github.com/nodar/openzaps/blob/main/scripts/instant-launch-bot.mjs"
            target="_blank"
            rel="noreferrer"
          >
            View Bot Source ↗
          </a>
        </div>
      </section>
    </main>
  );
}