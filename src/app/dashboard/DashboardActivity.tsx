"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";

import { OPENZAP_CONTRACTS, explorerTransaction, explorerAddress } from "@/lib/robinhood";
import type { ActivityEntry, ProtocolActivity } from "@/lib/activity";
import styles from "./dashboard.module.css";

export type ActivityPayload = ProtocolActivity & { headBlock: string };

type FeedState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: ActivityPayload; staleSince: string | null };

const TYPE_LABEL: Record<ActivityEntry["type"], string> = {
  created: "Zap created",
  executed: "Executed",
  recovered: "Recovered",
};

export function DashboardActivity({ initial }: { initial: ActivityPayload | null }): React.JSX.Element {
  const [state, setState] = useState<FeedState>(
    initial ? { status: "ready", data: initial, staleSince: null } : { status: "loading" },
  );
  const requestSeq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    try {
      const response = await fetch("/api/protocol/activity", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as ActivityPayload;
      if (seq !== requestSeq.current) return; // an out-of-order response must never overwrite fresher data
      setState({ status: "ready", data, staleSince: null });
    } catch {
      if (seq !== requestSeq.current) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const stale = state.status === "ready" ? state.staleSince : null;

  return (
    <>
      <section className={`container ${styles.metrics}`} aria-label="Live protocol totals">
        {state.status === "ready" ? (
          <>
            <Metric label="Zaps created" value={String(state.data.stats.zapsCreated)} />
            <Metric label="Executions" value={String(state.data.stats.executions)} />
            <Metric label="Recoveries" value={String(state.data.stats.recoveries)} />
            <Metric
              label="Executed volume"
              value={
                Object.entries(state.data.stats.executedVolume)
                  .map(([symbol, wei]) => `${formatAmount(wei)} ${symbol}`)
                  .join(" · ") || "None yet"
              }
            />
          </>
        ) : (
          <>
            <Metric label="Zaps created" value={state.status === "loading" ? "…" : "—"} srValue={state.status === "loading" ? "loading" : "unavailable"} />
            <Metric label="Executions" value={state.status === "loading" ? "…" : "—"} srValue={state.status === "loading" ? "loading" : "unavailable"} />
            <Metric label="Recoveries" value={state.status === "loading" ? "…" : "—"} srValue={state.status === "loading" ? "loading" : "unavailable"} />
            <Metric label="Executed volume" value={state.status === "loading" ? "…" : "—"} srValue={state.status === "loading" ? "loading" : "unavailable"} />
          </>
        )}
      </section>

      <section className={`container ${styles.feedWrap}`} aria-label="Live zap transactions">
        <div className={styles.feedHead}>
          <div>
            <span className="eyebrow">Live zap transactions</span>
            <h2 ref={headingRef} tabIndex={-1}>Onchain activity feed.</h2>
          </div>
          <p className={styles.updated}>
            {state.status === "ready"
              ? `Head block ${Number(state.data.headBlock).toLocaleString()} · refreshed ${new Date(state.data.updatedAt).toLocaleTimeString("en-US")}`
              : state.status === "loading"
                ? "Reading Robinhood Chain logs…"
                : ""}
          </p>
        </div>

        <div aria-live="polite">
          {stale && (
            <div className={styles.staleWarning}>
              Refresh has been failing since {new Date(stale).toLocaleTimeString("en-US")} — the rows below are the
              last verified snapshot and their relative times may be off.
            </div>
          )}
        </div>

        {state.status === "loading" && <p className={styles.empty}>Reading creations, executions, and recoveries from chain logs…</p>}

        {state.status === "unavailable" && (
          <div className={styles.unavailable} role="alert">
            <p>Live activity is unavailable right now — the Robinhood RPC log query failed. Nothing is shown rather than showing stale or fabricated rows.</p>
            <button
              className="btn btnGhost"
              onClick={() => {
                setState({ status: "loading" });
                headingRef.current?.focus();
                void load();
              }}
              type="button"
            >
              Retry
            </button>
          </div>
        )}

        {state.status === "ready" && state.data.activity.length === 0 && (
          <p className={styles.empty}>No onchain activity yet. The first factory creation will appear here.</p>
        )}

        {state.status === "ready" && state.data.activity.length > 0 && (
          <div className={styles.feed}>
            {state.data.activity.map((entry) => (
              <a
                className={styles.feedRow}
                href={explorerTransaction(entry.txHash)}
                key={`${entry.txHash}:${entry.logIndex}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className={styles.feedType} data-type={entry.type}>{TYPE_LABEL[entry.type]}</span>
                <span className={styles.feedDetail}>
                  {entry.type === "created"
                    ? `by ${shortAddress(entry.actor)}`
                    : `${entry.amount ? formatAmount(entry.amount) : "?"} ${entry.assetSymbol ?? ""} → ${shortAddress(entry.actor)}`}
                </span>
                <code className={styles.feedZap}>{shortAddress(entry.zap)}</code>
                <span className={styles.feedTime}>
                  {entry.timestamp ? timeAgo(entry.timestamp) : `block ${Number(entry.blockNumber).toLocaleString()}`}
                  {" "}
                  <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </span>
              </a>
            ))}
          </div>
        )}

        <p className={styles.feedNote}>
          Execution and recovery rows are read only from zaps recorded in the factory&apos;s own ZapCreated log;
          events emitted by non-canonical contracts never reach this feed. View any zap directly on{" "}
          <a href={explorerAddress(OPENZAP_CONTRACTS.factory)} target="_blank" rel="noreferrer">
            Blockscout ↗
          </a>
          .
        </p>
      </section>
    </>
  );
}

function Metric({ label, value, srValue }: { label: string; value: string; srValue?: string }): React.JSX.Element {
  return (
    <div className={styles.metric}>
      <strong aria-label={srValue ? `${label}: ${srValue}` : undefined}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatAmount(wei: string): string {
  const value = BigInt(wei);
  if (value > 0n && value < 10n ** 14n) return "<0.0001";
  const formatted = formatUnits(value, 18);
  const [whole, fraction = ""] = formatted.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return `${grouped}${trimmed ? `.${trimmed}` : ""}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
