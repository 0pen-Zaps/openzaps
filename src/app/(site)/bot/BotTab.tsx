"use client";

import styles from "./bot.module.css";

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

export function BotTab({ status }: { status: BotStatus | null }) {
  if (!status) {
    return (
      <section className={styles.tableSection}>
        <div className={styles.emptyPanel}>
          <h3>Loading bot status…</h3>
          <p>Fetching from /api/bot/status</p>
        </div>
      </section>
    );
  }

  const s = status.strategy;
  const sess = status.session;

  return (
    <section className={styles.tableSection}>
      <div className={styles.detailGrid}>
        {/* Entry */}
        <div className={styles.detailCard}>
          <h3>Entry Criteria</h3>
          {[
            ["Min Score", String(s.entry.minScore)],
            ["Min Buyers", String(s.entry.minBuyers)],
            ["Max Age", s.entry.maxAgeBlocks + " blocks"],
            ["Max 1st Buyer", "+" + s.entry.maxFirstBuyerBlock + " blocks"],
          ].map(([k, v]) => (
            <div key={k} className={styles.detailRow}><span>{k}</span><span className={styles.monoCell}>{v}</span></div>
          ))}
        </div>

        {/* Exit */}
        <div className={styles.detailCard}>
          <h3>Exit Rules</h3>
          {[
            ["TP1", "+" + s.exit.tp1 + "% sell " + (s.exit.tp1Fraction * 100) + "%"],
            ["TP2", "+" + s.exit.tp2 + "% sell " + (s.exit.tp2Fraction * 100) + "%"],
            ["Stop Loss", s.exit.stopLoss + "%"],
            ["Dead Trade", s.exit.deadMinutes + "m <2% movement"],
            ["Max Hold", s.exit.maxHoldMinutes + "m"],
          ].map(([k, v]) => (
            <div key={k} className={styles.detailRow}><span>{k}</span><span>{v}</span></div>
          ))}
        </div>

        {/* Sizing */}
        <div className={styles.detailCard}>
          <h3>Position Sizing</h3>
          {[
            ["Base Size", s.sizing.basePct + "% of bankroll"],
            ["Max Size", s.sizing.maxPct + "%"],
            ["Gas Reserve", s.sizing.gasReserve + " ETH"],
          ].map(([k, v]) => (
            <div key={k} className={styles.detailRow}><span>{k}</span><span>{v}</span></div>
          ))}
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
            Loss streak: halve size. 3 consecutive wins: +25% bonus.
          </p>
        </div>

        {/* Edge */}
        <div className={styles.detailCard}>
          <h3>Edge</h3>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>{s.edge}</p>
        </div>
      </div>

      {sess && (
        <>
          <div className={styles.detailGrid} style={{ marginTop: 16 }}>
            <div className={styles.detailCard}>
              <h3>Session Stats</h3>
              {[
                ["Status", sess.status + (sess.running ? " 🟢" : " ⏸️")],
                ["Bankroll", sess.bankroll.toFixed(4) + " ETH"],
                ["PnL", (sess.pnl >= 0 ? "+" : "") + sess.pnl.toFixed(4) + " ETH"],
                ["Trades", String(sess.trades)],
                ["Win Rate", sess.winRate + "% (" + sess.wins + "W/" + sess.losses + "L)"],
                ["State Age", sess.stateAgeSeconds + "s ago"],
              ].map(([k, v]) => (
                <div key={k} className={styles.detailRow}>
                  <span>{k}</span>
                  <span className={styles.monoCell} style={{ color: k === "PnL" ? (sess.pnl >= 0 ? "var(--ok)" : "var(--danger)") : undefined }}>
                    {v}
                  </span>
                </div>
              ))}
            </div>

            {sess.currentTrade && (
              <div className={styles.detailCard}>
                <h3>Current Position</h3>
                {[
                  ["Token", "$" + sess.currentTrade.sym],
                  ["Block", String(sess.currentTrade.entryBlock)],
                  ["Size", sess.currentTrade.entryEth.toFixed(4) + " ETH"],
                ].map(([k, v]) => (
                  <div key={k} className={styles.detailRow}><span>{k}</span><span className={styles.monoCell}>{v}</span></div>
                ))}
              </div>
            )}
          </div>

          {sess.history.length > 0 && (
            <div className={styles.detailCard} style={{ marginTop: 16 }}>
              <h3>Trade History (last 10)</h3>
              <div className={styles.table}>
                <div className={styles.tableRow + " " + styles.tableRowHeader}>
                  <span>Token</span><span>PnL%</span><span>Reason</span><span>Dur</span>
                </div>
                {sess.history.slice(0, 10).map((t, i) => (
                  <div key={i} className={styles.tableRow}>
                    <span className={styles.tokenSymbol}>$<span>{t.sym}</span></span>
                    <span style={{ color: t.pnlPct >= 0 ? "var(--ok)" : "var(--danger)", fontWeight: 600 }}>
                      {t.pnlPct >= 0 ? "+" : ""}<span>{t.pnlPct.toFixed(1)}%</span>
                    </span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t.reason}</span>
                    <span className={styles.monoCell}>{t.dur.toFixed(1)}m</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}