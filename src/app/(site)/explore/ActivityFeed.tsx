"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";

import { OPENZAP_CONTRACTS, explorerTransaction, explorerAddress } from "@/lib/robinhood";
import type { ActivityEntry, ProtocolActivity } from "@/lib/activity";
import { CountUp } from "@/components/CountUp";
import styles from "./feed.module.css";

export type ActivityPayload = ProtocolActivity & { headBlock: string };

type FeedState =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      data: ActivityPayload;
      staleSince: string | null;
      /** Rows that appeared in this payload but not the previous one. */
      fresh: ReadonlySet<string>;
    };

const TYPE_LABEL: Record<ActivityEntry["type"], string> = {
  created: "Zap created",
  executed: "Executed",
  recovered: "Recovered",
};

export function ActivityFeed({ initial }: { initial: ActivityPayload | null }): React.JSX.Element {
  const [state, setState] = useState<FeedState>(
    initial ? { status: "ready", data: initial, staleSince: null, fresh: EMPTY } : { status: "loading" },
  );
  const requestSeq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      const response = await fetch("/api/protocol/activity", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as ActivityPayload;
      if (seq !== requestSeq.current) return; // an out-of-order response must never overwrite fresher data
      // Diffed inside the updater so it stays a pure function of the previous
      // state — no ref read during render, and safe under StrictMode replay.
      setState((current) => ({
        status: "ready",
        data,
        staleSince: null,
        fresh: current.status === "ready" ? diffRows(current.data, data) : EMPTY,
      }));
    } catch {
      if (seq !== requestSeq.current) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    } finally {
      if (seq === requestSeq.current) setRefreshing(false);
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
  const fresh = state.status === "ready" ? state.fresh : EMPTY;

  return (
    <>
      <section className={`container ${styles.metrics}`} aria-label="Live protocol totals">
        {state.status === "ready" ? (
          <>
            <Metric count label="Zaps created" value={String(state.data.stats.zapsCreated)} />
            <Metric count label="Executions" value={String(state.data.stats.executions)} />
            <Metric count label="Recoveries" value={String(state.data.stats.recoveries)} />
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
          ["Zaps created", "Executions", "Recoveries", "Executed volume"].map((label, i) =>
            state.status === "loading" ? (
              // Shaped placeholders rather than an ellipsis: the strip keeps its
              // height and reads as "arriving" instead of "empty".
              <div className={styles.skelMetric} key={label}>
                <span
                  aria-label={`${label}: loading`}
                  className={`skeleton ${styles.skelValue}`}
                  style={{ animationDelay: `${-i * 0.18}s` }}
                  role="status"
                />
                <span aria-hidden className={`skeleton ${styles.skelLabel}`} style={{ animationDelay: `${-i * 0.18}s` }} />
              </div>
            ) : (
              <Metric key={label} label={label} value="—" srValue="unavailable" />
            ),
          )
        )}
      </section>

      <section className={`container ${styles.feedWrap}`} aria-label="Live zap transactions">
        <div className={styles.feedHead}>
          <div>
            <span className="eyebrow">Live zap transactions</span>
            <h2 ref={headingRef} tabIndex={-1}>Onchain activity feed.</h2>
          </div>
          <p className={styles.updated}>
            {refreshing && <span aria-hidden className={`spinner ${styles.updatedSpinner}`} />}
            {state.status === "ready" ? (
              // The clock time is rendered in the server's timezone (UTC on
              // Vercel) and re-rendered in the visitor's, so the text legitimately
              // differs across hydration. Without this React treats it as a
              // mismatch, throws #418, and discards the whole server tree.
              <span suppressHydrationWarning>
                {`Head block ${Number(state.data.headBlock).toLocaleString()} · refreshed ${new Date(state.data.updatedAt).toLocaleTimeString("en-US")}`}
              </span>
            ) : state.status === "loading" ? (
              "Reading Robinhood Chain logs…"
            ) : (
              ""
            )}
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

        {state.status === "loading" && (
          <>
            <p className={styles.empty}>Reading creations, executions, and recoveries from chain logs…</p>
            {/* Shaped placeholders in the feed's real geometry, so the rows do not
                jump when the first payload lands. Negative, index-derived delays
                start each bar mid-cycle: the shimmer travels down the list
                instead of every row pulsing in lockstep. */}
            <div aria-hidden className={styles.feed}>
              {Array.from({ length: 5 }, (_, i) => (
                <div className={styles.skelRow} key={i} style={{ "--row-delay": `${-i * 0.14}s` } as React.CSSProperties}>
                  <i className="skeleton" />
                  <i className="skeleton" />
                  <i className="skeleton" />
                  <i className="skeleton" />
                </div>
              ))}
            </div>
          </>
        )}

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
            {state.data.activity.map((entry, i) => (
              <a
                className={styles.feedRow}
                data-fresh={fresh.has(`${entry.txHash}:${entry.logIndex}`)}
                href={explorerTransaction(entry.txHash)}
                key={`${entry.txHash}:${entry.logIndex}`}
                style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
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
                  {/* Relative to Date.now(), so the server's value and the
                      client's can land in different buckets between render and
                      hydration ("4h ago" vs "5h ago"). Same reasoning as above. */}
                  <span suppressHydrationWarning>
                    {entry.timestamp ? timeAgo(entry.timestamp) : `block ${Number(entry.blockNumber).toLocaleString()}`}
                  </span>
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

function Metric({
  label,
  value,
  srValue,
  count = false,
}: {
  label: string;
  value: string;
  srValue?: string;
  /** Roll the number up on first view. Off for composite/textual values. */
  count?: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.metric}>
      <strong aria-label={srValue ? `${label}: ${srValue}` : undefined}>
        {count ? <CountUp value={value} /> : value}
      </strong>
      <span>{label}</span>
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

const rowKey = (entry: ActivityEntry): string => `${entry.txHash}:${entry.logIndex}`;

/**
 * Row keys present in `next` but not in `previous`.
 *
 * Pure, so it can run inside a setState updater. The server-rendered first
 * payload has no predecessor and therefore highlights nothing — flashing every
 * row on initial load would carry no information.
 */
function diffRows(previous: ActivityPayload, next: ActivityPayload): ReadonlySet<string> {
  const before = new Set(previous.activity.map(rowKey));
  return new Set(next.activity.map(rowKey).filter((key) => !before.has(key)));
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
