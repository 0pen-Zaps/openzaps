"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { LINKS } from "@/lib/config";
import {
  fetchTokenMarketPulseClient,
  MARKET_REFRESH_MS,
  marketReadIsExpired,
} from "@/lib/market-client";
import type { TokenMarketPulse } from "@/lib/market-server";
import styles from "./growth.module.css";

const VOLUME_MILESTONES = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;

type PulseState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: TokenMarketPulse; stale: boolean };

export function nextVolumeMilestone(volumeUsd: number): number {
  return VOLUME_MILESTONES.find((milestone) => volumeUsd < milestone)
    ?? (Math.floor(volumeUsd / 1_000_000) + 1) * 1_000_000;
}

function marketAge(readAt: string, nowMs: number | null): string | null {
  if (nowMs === null) return null;
  const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(readAt)) / 1_000));
  if (!Number.isFinite(ageSeconds)) return null;
  if (ageSeconds < 60) return `${ageSeconds}s old`;
  return `${Math.floor(ageSeconds / 60)}m old`;
}

function usd(value: number, compact = false): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact || value >= 1_000 ? 0 : 2,
  }).format(value);
}

export function RewardsGrowthPulse({ initial }: { initial: TokenMarketPulse | null }): React.JSX.Element {
  const [state, setState] = useState<PulseState>(
    initial ? { status: "ready", data: initial, stale: false } : { status: "loading" },
  );
  const [shareState, setShareState] = useState<"idle" | "shared" | "copied" | "failed">("idle");
  const [clockMs, setClockMs] = useState<number | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      const data = await fetchTokenMarketPulseClient();
      if (mine === sequence.current) setState({ status: "ready", data, stale: false });
    } catch {
      if (mine !== sequence.current) return;
      const nowMs = Date.now();
      setState((current) => current.status === "ready" && !marketReadIsExpired(current.data, nowMs)
        ? { ...current, stale: true }
        : { status: "unavailable" });
    }
  }, []);

  useEffect(() => {
    const tick = (): void => {
      const nowMs = Date.now();
      setClockMs(nowMs);
      setState((current) => current.status === "ready" && marketReadIsExpired(current.data, nowMs)
        ? { status: "unavailable" }
        : current);
    };
    queueMicrotask(() => {
      tick();
      if (!initial) void load();
    });
    const timer = window.setInterval(() => {
      tick();
      if (document.visibilityState === "visible") void load();
    }, MARKET_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [initial, load]);

  const invite = useCallback(async (): Promise<void> => {
    const url = `${window.location.origin}/rewards?campaign=2&utm_source=community_invite&utm_medium=share&utm_campaign=campaign_2_volume`;
    const text = "0xZAPS Campaign 2 turns real trading fees into WETH for stakers and HOOKR buy-and-burns.";
    try {
      if (navigator.share) {
        await navigator.share({ title: "0xZAPS Campaign 2", text, url });
        setShareState("shared");
      } else {
        await navigator.clipboard.writeText(url);
        setShareState("copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareState("failed");
    }
  }, []);

  const market = state.status === "ready" ? state.data : null;
  const trades = market ? market.h24Buys + market.h24Sells : null;
  const milestone = market ? nextVolumeMilestone(market.h24VolumeUsd) : null;
  const milestoneProgress = market && milestone
    ? Math.min(100, (market.h24VolumeUsd / milestone) * 100)
    : 0;
  const marketStatus = state.status === "ready"
    ? state.stale ? "delayed" : "live"
    : state.status;
  const readAge = market ? marketAge(market.readAt, clockMs) : null;

  return (
    <section className={styles.pulse} aria-labelledby="rewards-growth-title" data-status={marketStatus}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <i aria-hidden />{marketStatus === "live" ? "Live" : marketStatus === "delayed" ? "Delayed" : "Market"} pulse · rolling 24h
        </span>
        <span>{marketStatus === "live" ? "Canonical 0xZAPS / aeWETH pool" : marketStatus === "delayed" ? "Last good read · retrying" : state.status === "loading" ? "Checking canonical pool" : "Market feed unavailable"}</span>
      </header>

      <div className={styles.thesis}>
        <div className={styles.volume}>
          <span>0xZAPS daily volume</span>
          <strong>{market ? usd(market.h24VolumeUsd) : state.status === "loading" ? "Checking…" : "—"}</strong>
          <small>{trades === null ? "Market feed unavailable" : `${trades.toLocaleString("en-US")} trades · buys + sells`}</small>
        </div>
        <div className={styles.copy}>
          <h2 id="rewards-growth-title">Use the pool. Bring the next trader.</h2>
          <p>
            Every fee-generating trade in the canonical pool feeds this tokenized fee stream.
            During Campaign 2, half works for stakers and half funds HOOKR market buys and burns.
          </p>
        </div>
      </div>

      <div className={styles.flow} role="img" aria-label="0xZAPS trading volume creates pool fees, split between staker WETH rewards and HOOKR buy-and-burns">
        <span><b>Trade</b><small>0xZAPS volume</small></span>
        <i aria-hidden>→</i>
        <span><b>Capture</b><small>real pool fees</small></span>
        <i aria-hidden>→</i>
        <span className={styles.split}><b>Split</b><small>WETH to stakers · HOOKR burned</small></span>
      </div>

      {market && milestone ? (
        <div className={styles.milestone}>
          <div>
            <span>Community volume marker</span>
            <strong>{usd(milestone, true)}</strong>
          </div>
          <div className={styles.track} aria-label={`${milestoneProgress.toFixed(1)}% toward the ${usd(milestone, true)} rolling-volume marker`}>
            <i style={{ transform: `scaleX(${milestoneProgress / 100})` }} />
          </div>
          <span>{milestoneProgress.toFixed(1)}%</span>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Link href={LINKS.buyWithOpenZaps} prefetch={false} className={styles.primary}>Buy with a Zap <span aria-hidden>→</span></Link>
        <a href={LINKS.clanker} target="_blank" rel="noreferrer" className={styles.secondary}>Trade on Clanker <span aria-hidden>↗</span></a>
        <button
          type="button"
          onClick={() => void invite()}
          className={styles.invite}
          data-analytics-event="growth_link_clicked"
          data-analytics-cta="invite_trader"
          data-analytics-content="campaign_2_volume"
        >Invite a trader</button>
        <span className={styles.shareStatus} aria-live="polite">
          {shareState === "shared" ? "Invite shared." : shareState === "copied" ? "Invite link copied." : shareState === "failed" ? "Copy the page URL to invite someone." : ""}
        </span>
      </div>

      <p className={styles.sourceNote}>
        {market ? <><a href={market.sourceUrl} target="_blank" rel="noreferrer">DEX Screener</a> rolling estimate, read {new Date(market.readAt).toISOString().replace("T", " ").slice(0, 16)} UTC{readAge ? ` · ${readAge}` : ""}. </> : null}
        Volume can fall and rewards may be zero. This is a participation marker, not a referral reward or yield projection.
      </p>
    </section>
  );
}
