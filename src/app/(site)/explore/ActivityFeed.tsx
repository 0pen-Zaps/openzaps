"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";

import { OPENZAP_CONTRACTS, explorerTransaction, explorerAddress } from "@/lib/robinhood";
import type { ActivityEntry, ProtocolActivity } from "@/lib/activity";
import { CountUp } from "@/components/CountUp";
import { BlockGlyph } from "@/app/(site)/zap/BlockGlyph";
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
  executed: "Zapped",
  automated: "AutoZap",
  recovered: "Recovered",
  halted: "Policy halted",
};

/** The mark each kind of log carries, so a row is readable before its text is. */
const TYPE_GLYPH: Record<ActivityEntry["type"], string> = {
  created: "lock",
  executed: "bolt",
  automated: "repeat",
  recovered: "key",
  halted: "shield",
};

const STAT_LABELS = ["Zaps created", "Zaps", "AutoZaps", "Recoveries", "Policies halted", "Executed volume"] as const;

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
      <section className={styles.statGrid} aria-label="Live protocol totals">
        {state.status === "ready" ? (
          <>
            <Metric count label="Zaps created" value={String(state.data.stats.zapsCreated)} />
            <Metric count label="Zaps" value={String(state.data.stats.executions)} />
            <Metric count label="AutoZaps" value={String(state.data.stats.automatedRuns)} />
            <Metric count label="Recoveries" value={String(state.data.stats.recoveries)} />
            <Metric count label="Policies halted" value={String(state.data.stats.policiesHalted)} />
            <Metric
              wide
              label="Executed volume"
              value={
                Object.entries(state.data.stats.executedVolume)
                  .map(([symbol, wei]) => `${formatAmount(wei)} ${symbol}`)
                  .join(" · ") || "None yet"
              }
            />
          </>
        ) : (
          STAT_LABELS.map((label, i) =>
            state.status === "loading" ? (
              // Shaped placeholders rather than an ellipsis: the strip keeps its
              // height and reads as "arriving" instead of "empty". The composite
              // volume placeholder spans the row like the value it stands in for,
              // or the strip changes height when the payload lands.
              <div
                className={`${styles.skelStat} ${label === "Executed volume" ? styles.statWide : ""}`.trim()}
                key={label}
              >
                <span
                  aria-label={`${label}: loading`}
                  className={`skeleton ${styles.skelValue}`}
                  style={{ animationDelay: `${-i * 0.18}s` }}
                  role="status"
                />
                <span aria-hidden className={`skeleton ${styles.skelLabel}`} style={{ animationDelay: `${-i * 0.18}s` }} />
              </div>
            ) : (
              <Metric key={label} label={label} value="—" srValue="unavailable" wide={label === "Executed volume"} />
            ),
          )
        )}
      </section>

      <section className={styles.card} aria-label="Onchain activity">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} ref={headingRef} tabIndex={-1}>
            Onchain activity
          </h2>
          <span className={styles.cardSub}>creations, Zaps, AutoZaps, permanent stops, and recoveries — newest first</span>
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
            <p className={styles.empty}>Reading creations, Zaps, AutoZaps, policy stops, and recoveries from chain logs…</p>
            {/* Shaped placeholders in the feed's real geometry, so the rows do not
                jump when the first payload lands. Negative, index-derived delays
                start each bar mid-cycle: the shimmer travels down the list
                instead of every row pulsing in lockstep. */}
            <div aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <div className={styles.skelRow} key={i} style={{ "--row-delay": `${-i * 0.14}s` } as React.CSSProperties}>
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
            <p>Live activity is unavailable right now — the Robinhood RPC log query failed. Nothing is shown instead of stale or fabricated rows.</p>
            <button
              className={styles.ghostBtn}
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

        {state.status === "ready" &&
          state.data.activity.length > 0 &&
          state.data.activity.map((entry, i) => (
            <a
              className={styles.feedRow}
              data-fresh={fresh.has(`${entry.txHash}:${entry.logIndex}`)}
              href={explorerTransaction(entry.txHash)}
              key={`${entry.txHash}:${entry.logIndex}`}
              style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
              target="_blank"
              rel="noreferrer"
            >
              <span className={styles.feedGlyph} data-type={entry.type}>
                <BlockGlyph name={TYPE_GLYPH[entry.type]} />
              </span>
              <span className={styles.feedBody}>
                <span className={styles.feedKind}>{TYPE_LABEL[entry.type]}</span>
                <strong className={styles.feedTitle}>{rowTitle(entry)}</strong>
                {entry.type === "automated" && (
                  // The actor on an automated row is the EXECUTOR that submitted it, not the
                  // recipient — naming it "→ 0x…" would read as the destination of the output.
                  <span className={styles.feedDetail}>
                    {entry.detail ?? "automated"} · submitted by {shortAddress(entry.actor)}
                  </span>
                )}
                {entry.type === "halted" && (
                  <span className={styles.feedDetail}>
                    Permanent stop by {shortAddress(entry.actor)} · execution cannot be reactivated
                  </span>
                )}
              </span>
              <span className={styles.feedEnd}>
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
              </span>
            </a>
          ))}

        <p className={styles.cardFoot}>
          Zap, AutoZap, recovery, and policy-halt rows are read only from Zaps recorded in a factory&apos;s own
          ZapCreated log. Policy halts are accepted only from configured v1.2 and v3.2 emitters; v1.1, v3, and
          v3.1 remain unsupported. An AutoZap row is a Zap an executor submitted against
          a standing authorization its owner signed. Each row opens its own transaction; the v1.1 factory is on{" "}
          <a href={explorerAddress(OPENZAP_CONTRACTS.factory)} target="_blank" rel="noreferrer">
            Blockscout ↗
          </a>
          .
        </p>
      </section>
    </>
  );
}

/**
 * The one line that says what happened.
 *
 * `actor` means something different per kind — the owner on a creation, the
 * recipient on a one-shot execution, the owner again on a recovery, and the
 * EXECUTOR on an automated run. Only the first three can carry an arrow; the
 * automated case names its executor in the detail line instead.
 */
function rowTitle(entry: ActivityEntry): string {
  const amount = `${entry.amount ? formatAmount(entry.amount) : "?"} ${entry.assetSymbol ?? ""}`.trim();
  if (entry.type === "created") return `Created by ${shortAddress(entry.actor)}`;
  if (entry.type === "automated") return amount;
  if (entry.type === "halted") return "Execution permanently stopped";
  return `${amount} → ${shortAddress(entry.actor)}`;
}

function Metric({
  label,
  value,
  srValue,
  count = false,
  wide = false,
}: {
  label: string;
  value: string;
  srValue?: string;
  /** Roll the number up on first view. Off for composite/textual values. */
  count?: boolean;
  /** Span the whole strip. For the composite volume string, not the counters. */
  wide?: boolean;
}): React.JSX.Element {
  return (
    <div className={`${styles.statCard} ${wide ? styles.statWide : ""}`.trim()}>
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
