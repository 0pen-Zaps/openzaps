"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CHAIN } from "@/lib/config";
import styles from "./bot.module.css";
import { BotTab } from "./BotTab";

// ── Types ──────────────────────────────────────────────────────────────────

interface DexData {
  vol5m: number; vol1h: number; vol6h: number; vol24h: number;
  liq: number; fdv: number; mcap: number;
  price: string; priceChange5m: number; priceChange1h: number; priceChange24h: number;
  buys24h: number; sells24h: number; buys1h: number; sells1h: number;
  created: number; url: string; dexId: string;
}

interface ScoreBreakdown {
  buyerCount: number; buyerScore: number; buyerWeight: number;
  nameQuality: number; nameScore: number; nameWeight: number;
  timingBlocks: number | null; timingScore: number; timingWeight: number;
  velocity: number; velocityScore: number; velocityWeight: number;
  diversity: number; diversityScore: number; diversityWeight: number;
}

interface LaunchRow {
  token: string; name: string; symbol: string;
  block: number; txHash: string;
  realBuyers: number; firstBuyerBlock: number | null;
  ageMinutes: number; ageBlocks: number;
  supply: string;
  dex: DexData | null;
  score: number; decision: "BUY" | "SKIP"; reason: string;
  scoreBreakdown: ScoreBreakdown;
}

interface LeaderEntry {
  token: string; symbol: string; name: string;
  vol24h: number; liq: number; fdv: number; price: string;
  priceChange24h: number; ageHours: number; buys24h: number; sells24h: number;
  realBuyers: number; score: number; url: string;
}

interface Analytics {
  totalRecent: number; totalFetched: number;
  avgBuyers: number; medianBuyers: number;
  buySignals: number; withVolume: number;
  scoreDistribution: Record<number, number>;
  buyerDistribution: { bucket: string; count: number }[];
  launchVelocity: number;
  topVolumeSum: number;
}

interface ApiResponse {
  launches: LaunchRow[];
  leaderboard: LeaderEntry[];
  analytics: Analytics;
  meta: { cached: boolean; stale?: boolean; fetchedAt: number };
}

interface BotSession {
  bankroll: number; available: number; pnl: number;
  trades: number; wins: number; losses: number; winRate: number;
  status: string; action: string; stateAgeSeconds: number; running: boolean;
  currentTrade: { token: string; sym: string; entryBlock: number; entryPrice: number; entryEth: number } | null;
  history: { sym: string; pnlPct: number; pnl: number; reason: string; dur: number; ts: number }[];
}

interface BotStrategy {
  entry: { minScore: number; minBuyers: number; maxAgeBlocks: number; maxFirstBuyerBlock: number };
  exit: { tp1: number; tp1Fraction: number; tp2: number; tp2Fraction: number; stopLoss: number; deadMinutes: number; maxHoldMinutes: number };
  sizing: { basePct: number; maxPct: number; gasReserve: number };
  edge: string;
}

interface BotStatus {
  strategy: BotStrategy;
  session: BotSession | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REFRESH_MS = 25_000;
const VOL_TIERS = [
  { min: 100_000, label: "🦄 Mega", cls: "volMega" },
  { min: 10_000, label: "🔥 Hot", cls: "volHot" },
  { min: 1_000, label: "📈 Active", cls: "volActive" },
  { min: 0, label: "—", cls: "" },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(n: number, decimals = 2): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(decimals)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(decimals)}K`;
  return `$${n.toFixed(decimals)}`;
}

function fmtAddr(addr: string): string { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }

function timeAgo(m: number): string {
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function scr(n: number): string { return n > 0 ? `+${n}` : `${n}`; }

function volTier(vol: number) { for (const t of VOL_TIERS) { if (vol >= t.min) return t; } return VOL_TIERS[VOL_TIERS.length - 1]; }

const PING_COLOR = { 0: "var(--ink-3)", 1: "var(--ok)", 2: "var(--warn)" } as const;
const PING_LABEL = { 0: "Disconnected", 1: "Live", 2: "Stale" } as const;

// ── Page ───────────────────────────────────────────────────────────────────

export default function BotPage(): React.JSX.Element {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"monitor" | "leaderboard" | "analytics" | "bot">("monitor");
  const [filter, setFilter] = useState<"all" | "buy" | "volume">("all");
  const [selectedLaunch, setSelectedLaunch] = useState<LaunchRow | null>(null);
  const [sortKey, setSortKey] = useState<string>("ageMinutes");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [ping, setPing] = useState<0 | 1 | 2>(0);
  const [refreshCountdown, setRefreshCountdown] = useState(REFRESH_MS / 1000);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch("/api/bot/launches");
      const d = await r.json();
      if (d.launches) {
        setData(d);
        setError(null);
        setPing(d.meta.stale ? 2 : 1);
      } else {
        setError(d.error || "No data");
        setPing(0);
      }
    } catch {
      setError("Fetch failed");
      setPing(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, REFRESH_MS);
    timerRef.current = setInterval(() => {
      setRefreshCountdown(prev => prev <= 1 ? REFRESH_MS / 1000 : prev - 1);
    }, 1000);
    return () => { clearInterval(int); clearInterval(timerRef.current); };
  }, [fetchData]);

  const launches = data?.launches ?? [];
  const leaderboard = data?.leaderboard ?? [];
  const analytics = data?.analytics;

  // Filtered + sorted
  const displayLaunches = useMemo(() => {
    let list: LaunchRow[] = launches;
    if (filter === "buy") list = list.filter(l => l.decision === "BUY");
    if (filter === "volume") list = list.filter(l => l.dex && l.dex.vol24h > 100);

    return [...list].sort((a, b) => {
      const getVal = (row: LaunchRow, key: string): number => {
        switch (key) {
          case "score": return row.score;
          case "ageMinutes": return row.ageMinutes;
          case "realBuyers": return row.realBuyers;
          case "firstBuyerBlock": return row.firstBuyerBlock ?? 9999;
          case "block": return row.block;
          default: return 0;
        }
      };
      return (getVal(a, sortKey) - getVal(b, sortKey)) * sortDir;
    });
  }, [launches, filter, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) { setSortDir(d => (d * -1) as 1 | -1); } else { setSortKey(key); setSortDir(-1); }
  }

  function SortHead({ col, label }: { col: string; label: string }) {
    return (
      <button className={styles.sortHead} onClick={() => toggleSort(col)}>
        {label} {sortKey === col ? (sortDir === 1 ? "▲" : "▼") : ""}
      </button>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <main className={styles.page} id="main" data-screen-label="ZapBot">
      {/* ── Hero header ─────────────────────────────────────────────────── */}
      <section className={styles.header}>
        <div className={styles.headerTop}>
          <div>
            <p className={styles.eyebrow}>
              <span style={{ background: `var(${PING_COLOR[ping]})`, boxShadow: `0 0 0 4px ${ping === 1 ? "var(--ok-wash)" : "var(--warn-wash)"}` }} aria-hidden />
              {PING_LABEL[ping]} · Uniswap Instant Launch · {CHAIN.name}
            </p>
            <h1>ZapBot</h1>
            <p className={styles.subtitle}>
              Real-time launch monitoring, scoring engine, and leaderboard. Refreshes every {REFRESH_MS / 1000}s.
              {analytics && <> · {analytics.buySignals} signals · {analytics.launchVelocity} launches/hr</>}
            </p>
          </div>
          <div className={styles.refreshBadge}>
            <span className={styles.refreshDot} style={{ background: `var(${PING_COLOR[ping]})` }} />
            {refreshCountdown}s
          </div>
        </div>

        {/* Mini stats row */}
        {analytics && (
          <div className={styles.headerStats}>
            {[
              ["Launches", analytics.totalFetched.toLocaleString()],
              ["Avg Buyers", String(analytics.avgBuyers)],
              ["Buy Signals", String(analytics.buySignals)],
              ["Median Buyers", String(analytics.medianBuyers)],
              ["With Volume", String(analytics.withVolume)],
              ["Launch Rate", `${analytics.launchVelocity}/hr`],
            ].map(([label, value]) => (
              <div className={styles.statCard} key={label}>
                <span className={styles.statLabel}>{label}</span>
                <span className={styles.statValue}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <section className={styles.filterBar}>
        <div className={styles.tabs}>
          {(["monitor", "leaderboard", "analytics", "bot"] as const).map(t => (
            <button key={t} className={`${styles.tab} ${tab === t ? styles.tabActive : ""}`} onClick={() => setTab(t)}>
              {t === "monitor" ? "🔍 Live Monitor" : t === "leaderboard" ? "🏆 Leaderboard" : t === "analytics" ? "📊 Analytics" : "⚡ Bot"}
              {t === "leaderboard" && leaderboard.length > 0 && <span className={styles.chip}>{leaderboard.length}</span>}
              {t === "bot" && botStatus?.session?.trades !== undefined && botStatus.session.trades > 0 && <span className={styles.chip}>{botStatus.session.trades}</span>}
            </button>
          ))}
        </div>
        <div className={styles.filterRight}>
          {tab === "monitor" && (
            <div className={styles.subTabs}>
              {(["all", "buy", "volume"] as const).map(f => (
                <button key={f} className={`${styles.subTab} ${filter === f ? styles.subTabActive : ""}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "buy" ? "Buys" : "Volume"}
                </button>
              ))}
            </div>
          )}
          <span className={styles.filterInfo}>
            {loading ? "Loading…" : error ? <span className={styles.errorText}>{error}</span> : `${displayLaunches.length} shown`}
          </span>
        </div>
      </section>

      {/* ── LIVE MONITOR TAB ─────────────────────────────────────────────── */}
      {tab === "monitor" && (
        <section className={styles.tableSection}>
          <div className={styles.table}>
            <div className={`${styles.tableRow} ${styles.tableRowHeader}`}>
              <SortHead col="score" label="Score" />
              <SortHead col="symbol" label="Token" />
              <SortHead col="ageMinutes" label="Age" />
              <SortHead col="realBuyers" label="Buyers" />
              <SortHead col="firstBuyerBlock" label="1st" />
              <span className={styles.colSmall}>Vol 1h</span>
              <span className={styles.colSmall}>Vol 24h</span>
              <span className={styles.colSmall}>Liq</span>
              <span className={styles.colSmall}>FDV</span>
              <span className={styles.colAction}>Decision</span>
            </div>

            {displayLaunches.map(launch => {
              const tier = launch.dex ? volTier(launch.dex.vol24h) : VOL_TIERS[VOL_TIERS.length - 1];
              return (
                <div
                  key={launch.txHash}
                  className={`${styles.tableRow} ${selectedLaunch?.txHash === launch.txHash ? styles.tableRowSelected : ""} ${tier.cls ? styles[tier.cls as keyof typeof styles] ?? "" : ""}`}
                  onClick={() => setSelectedLaunch(selectedLaunch?.txHash === launch.txHash ? null : launch)}
                  role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter") setSelectedLaunch(launch); }}
                >
                  <span className={styles.colScore}>
                    <span className={`${styles.scoreBadge} ${launch.score >= 6 ? styles.scoreBuy : styles.scoreSkip}`}>
                      {launch.score}
                    </span>
                  </span>
                  <span className={styles.colToken}>
                    <span className={styles.tokenSymbol}>${launch.symbol}</span>
                    <span className={styles.tokenName}>{launch.name}{tier.label !== "—" && <span className={styles.tierLabel}>{tier.label}</span>}</span>
                  </span>
                  <span className={styles.colAge}>{timeAgo(launch.ageMinutes)}</span>
                  <span className={styles.colNum}>{launch.realBuyers}</span>
                  <span className={styles.colNum}>{launch.firstBuyerBlock ?? "—"}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{launch.dex ? fmtNum(launch.dex.vol1h, 0) : "—"}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{launch.dex ? fmtNum(launch.dex.vol24h) : "—"}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{launch.dex ? fmtNum(launch.dex.liq) : "—"}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{launch.dex ? fmtNum(launch.dex.fdv, 0) : "—"}</span>
                  <span className={styles.colAction}>
                    <span className={`${styles.decisionBadge} ${launch.decision === "BUY" ? styles.statusBuy : styles.statusSkip}`}>
                      {launch.decision === "BUY" ? "BUY" : "SKIP"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── LEADERBOARD TAB ──────────────────────────────────────────────── */}
      {tab === "leaderboard" && (
        <section className={styles.tableSection}>
          {leaderboard.length === 0 ? (
            <div className={styles.emptyPanel}>
              <h3>No volume data yet</h3>
              <p>Leaderboard populates when DexScreener has volume data for recent launches.</p>
            </div>
          ) : (
            <div className={styles.table}>
              <div className={`${styles.tableRow} ${styles.tableRowHeader}`}>
                <span>#</span>
                <span>Token</span>
                <span>24h Vol</span>
                <span>Liq</span>
                <span>FDV</span>
                <span>24h Chg</span>
                <span>24h Txns</span>
                <span>Buyers</span>
              </div>
              {leaderboard.map((entry, i) => (
                <a key={entry.token} href={entry.url} target="_blank" rel="noreferrer" className={styles.tableRow} style={{ textDecoration: "none", color: "inherit" }}>
                  <span className={styles.rankCol}>{i + 1}</span>
                  <span className={styles.colToken}>
                    <span className={styles.tokenSymbol}>${entry.symbol}</span>
                    <span className={styles.tokenName}>{entry.name}</span>
                  </span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{fmtNum(entry.vol24h)}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{fmtNum(entry.liq)}</span>
                  <span className={`${styles.colSmall} ${styles.monoCell}`}>{fmtNum(entry.fdv, 0)}</span>
                  <span style={{ color: entry.priceChange24h >= 0 ? "var(--ok)" : "var(--danger)", fontSize: 13 }}>
                    {scr(entry.priceChange24h)}%
                  </span>
                  <span className={styles.colSmall}>{entry.buys24h}B / {entry.sells24h}S</span>
                  <span className={styles.colNum}>{entry.realBuyers}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── ANALYTICS TAB ────────────────────────────────────────────────── */}
      {tab === "analytics" && analytics && (
        <section className={styles.analyticsSection}>
          <div className={styles.analyticsGrid}>
            {/* Score distribution */}
            <div className={styles.analyticsCard}>
              <h3>Score Distribution</h3>
              <div className={styles.barChart}>
                {Array.from({ length: 11 }, (_, i) => {
                  const count = analytics.scoreDistribution[i] || 0;
                  const max = Math.max(...Object.values(analytics.scoreDistribution), 1);
                  return (
                    <div key={i} className={styles.barRow}>
                      <span className={styles.barLabel}>{i}</span>
                      <div className={styles.barTrack}>
                        <div className={styles.bar} style={{ width: `${(count / max) * 100}%` }} />
                      </div>
                      <span className={styles.barCount}>{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Buyer distribution */}
            <div className={styles.analyticsCard}>
              <h3>Buyer Distribution</h3>
              <div className={styles.barChart}>
                {analytics.buyerDistribution.map(b => {
                  const max = Math.max(...analytics.buyerDistribution.map(x => x.count), 1);
                  return (
                    <div key={b.bucket} className={styles.barRow}>
                      <span className={styles.barLabel}>{b.bucket}</span>
                      <div className={styles.barTrack}>
                        <div className={styles.bar} style={{ width: `${(b.count / max) * 100}%`, background: "var(--zap)" }} />
                      </div>
                      <span className={styles.barCount}>{b.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Summary */}
            <div className={styles.analyticsCard}>
              <h3>Summary</h3>
              <div className={styles.analyticsGrid2}>
                {[
                  ["Fetched", analytics.totalFetched.toLocaleString()],
                  ["Shown", analytics.totalRecent.toLocaleString()],
                  ["Avg buyers", String(analytics.avgBuyers)],
                  ["Median buyers", String(analytics.medianBuyers)],
                  ["Buy signals", String(analytics.buySignals)],
                  ["With volume", String(analytics.withVolume)],
                  ["Launch rate", `${analytics.launchVelocity}/hr`],
                  ["Total 24h vol", fmtNum(analytics.topVolumeSum)],
                ].map(([k, v]) => (
                  <div key={k} className={styles.analyticsRow}>
                    <span>{k}</span>
                    <span className={styles.monoCell}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Detail panel ─────────────────────────────────────────────────── */}
      {selectedLaunch && (
        <section className={styles.detailPanel}>
          <header className={styles.detailHeader}>
            <div>
              <h2>${selectedLaunch.symbol} — {selectedLaunch.name}</h2>
              <p className={styles.detailMeta}>
                Block {selectedLaunch.block.toLocaleString()} · {timeAgo(selectedLaunch.ageMinutes)} · {selectedLaunch.realBuyers} buyers · Score {selectedLaunch.score}/10
              </p>
            </div>
            <button className={styles.closeBtn} onClick={() => setSelectedLaunch(null)}>✕</button>
          </header>

          <div className={styles.detailGrid}>
            {/* Token info */}
            <div className={styles.detailCard}>
              <h3>Token</h3>
              <div className={styles.detailRow}><span>Address</span><a href={`${CHAIN.explorer}/address/${selectedLaunch.token}`} target="_blank" rel="noreferrer" className={styles.monoLink}>{fmtAddr(selectedLaunch.token)} ↗</a></div>
              <div className={styles.detailRow}><span>Tx</span><a href={`${CHAIN.explorer}/tx/${selectedLaunch.txHash}`} target="_blank" rel="noreferrer" className={styles.monoLink}>{fmtAddr(selectedLaunch.txHash)} ↗</a></div>
              <div className={styles.detailRow}><span>Supply</span><span className={styles.monoCell}>{(BigInt(selectedLaunch.supply || "0") / BigInt(10 ** 18)).toLocaleString()}</span></div>
              <div className={styles.detailRow}><span>Age</span><span>{selectedLaunch.ageBlocks} blocks ({timeAgo(selectedLaunch.ageMinutes)})</span></div>
            </div>

            {/* Score breakdown */}
            <div className={styles.detailCard}>
              <h3>Score Breakdown</h3>
              {(["buyerCount", "nameQuality", "timingBlocks", "velocity", "diversity"] as const).map(metric => {
                const b = selectedLaunch.scoreBreakdown;
                const val = metric === "buyerCount" ? b.buyerCount :
                  metric === "nameQuality" ? `${b.nameQuality}/3` :
                  metric === "timingBlocks" ? (b.timingBlocks !== null ? `+${b.timingBlocks} blk` : "—") :
                  metric === "velocity" ? b.velocity.toFixed(3) :
                  `${b.diversity}`;
                const weight = metric === "buyerCount" ? b.buyerWeight :
                  metric === "nameQuality" ? b.nameWeight :
                  metric === "timingBlocks" ? b.timingWeight :
                  metric === "velocity" ? b.velocityWeight :
                  b.diversityWeight;
                const score = metric === "buyerCount" ? b.buyerScore :
                  metric === "nameQuality" ? b.nameScore :
                  metric === "timingBlocks" ? b.timingScore :
                  metric === "velocity" ? b.velocityScore :
                  b.diversityScore;
                const pct = ((score / 3) * weight * 100).toFixed(0);
                return (
                  <div key={metric} className={styles.scoreBreakdownRow}>
                    <div className={styles.sbHeader}>
                      <span className={styles.sbLabel}>{metric === "buyerCount" ? "Buyer Count" : metric === "nameQuality" ? "Name Quality" : metric === "timingBlocks" ? "First Buyer" : metric === "velocity" ? "Velocity" : "Diversity"}</span>
                      <span className={styles.sbWeight}>×{(weight * 100).toFixed(0)}%</span>
                    </div>
                    <div className={styles.sbBar}>
                      <div className={styles.sbFill} style={{ width: `${(score / 3) * 100}%` }} />
                    </div>
                    <div className={styles.sbFooter}>
                      <span className={styles.monoCell}>{val}</span>
                      <span className={styles.monoCell}>{score}/3 → {pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Market data */}
            {selectedLaunch.dex && (
              <div className={styles.detailCard}>
                <h3>Market Data</h3>
                <div className={styles.detailRow}><span>Vol 5m</span><span>{fmtNum(selectedLaunch.dex.vol5m, 0)}</span></div>
                <div className={styles.detailRow}><span>Vol 1h</span><span>{fmtNum(selectedLaunch.dex.vol1h, 0)}</span></div>
                <div className={styles.detailRow}><span>Vol 6h</span><span>{fmtNum(selectedLaunch.dex.vol6h)}</span></div>
                <div className={styles.detailRow}><span>Vol 24h</span><span>{fmtNum(selectedLaunch.dex.vol24h)}</span></div>
                <div className={styles.detailRow}><span>Liquidity</span><span>{fmtNum(selectedLaunch.dex.liq)}</span></div>
                <div className={styles.detailRow}><span>FDV</span><span>{fmtNum(selectedLaunch.dex.fdv, 0)}</span></div>
                <div className={styles.detailRow}><span>Price</span><span className={styles.monoCell}>{selectedLaunch.dex.price}</span></div>
              </div>
            )}

            {/* Price changes */}
            {selectedLaunch.dex && (
              <div className={styles.detailCard}>
                <h3>Price Changes</h3>
                {(["5m", "1h", "24h"] as const).map(p => {
                  const v = p === "5m" ? selectedLaunch.dex!.priceChange5m : p === "1h" ? selectedLaunch.dex!.priceChange1h : selectedLaunch.dex!.priceChange24h;
                  return (
                    <div key={p} className={styles.detailRow}>
                      <span>{p} Change</span>
                      <span style={{ color: v >= 0 ? "var(--ok)" : "var(--danger)", fontWeight: 600 }}>{scr(v)}%</span>
                    </div>
                  );
                })}
                <div className={styles.detailRow}><span>Txns 1h</span><span>{selectedLaunch.dex.buys1h}B / {selectedLaunch.dex.sells1h}S</span></div>
                <div className={styles.detailRow}><span>Txns 24h</span><span>{selectedLaunch.dex.buys24h}B / {selectedLaunch.dex.sells24h}S</span></div>
                <div className={styles.detailRow}><span>Tier</span><span>{volTier(selectedLaunch.dex.vol24h).label}</span></div>
                <a href={selectedLaunch.dex.url} target="_blank" rel="noreferrer" className={styles.dexLink}>DexScreener ↗</a>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── CTA footer ───────────────────────────────────────────────────── */}
      {tab === "bot" && <BotTab status={botStatus} />}

      <section className={styles.cta}>
        <h3>Run the bot</h3>
        <p>Execute live buys with your wallet on Robinhood Chain using the scoring engine above.</p>
        <div className={styles.ctaActions}>
          <code className={styles.codeBlock}>BOT_PRIVATE_KEY=0x… BOT_MAX_ETH_PER_BUY=0.02 node scripts/instant-launch-bot.mjs --live</code>
          <a className={styles.ctaBtn} href="https://github.com/nodar/openzaps/blob/main/scripts/instant-launch-bot.mjs" target="_blank" rel="noreferrer">View Bot Source ↗</a>
        </div>
      </section>
    </main>
  );
}