"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCampaignCountdown } from "@/components/useCampaignCountdown";
import { formatCountdown, type FeeRewardsPayload } from "@/lib/rewards";
import styles from "./landing.module.css";

const STRIP_BOUNDARY_POLL_MS = 30_000;
const STRIP_RETRY_DELAY_MS = 10_000;
const STRIP_FETCH_ATTEMPTS = 2;

/**
 * Hero highlight for the live 0xZAPS fee campaign.
 *
 * The landing page is statically prerendered, so this strip renders nothing
 * until a verified snapshot arrives at runtime and confirms a clock-bound
 * phase (upcoming, active, or claim-only). A marketing surface never invents
 * live claims: fetch failure, warming caches, and non-clock phases all fail
 * closed to the reserved empty slot rather than a synthesized countdown.
 */
export function CampaignStrip(): React.JSX.Element | null {
  const [data, setData] = useState<FeeRewardsPayload | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    for (let attempt = 0; attempt < STRIP_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch("/api/protocol/rewards", { cache: "no-store" });
        if (mine !== sequence.current) return;
        if (response.status === 200) {
          const payload = (await response.json()) as FeeRewardsPayload;
          if (mine !== sequence.current) return;
          setData(payload);
          return;
        }
      } catch {
        if (mine !== sequence.current) return;
      }
      if (attempt + 1 < STRIP_FETCH_ATTEMPTS) {
        // Jitter keeps a fleet of landing tabs that failed together (e.g. a
        // deploy-time cache miss) from retrying as one synchronized wave.
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, STRIP_RETRY_DELAY_MS + Math.round(Math.random() * 5_000));
        });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const resync = useCallback((): void => {
    void load();
  }, [load]);

  const { countdown, remaining, reached, reduced } = useCampaignCountdown(
    data,
    resync,
    STRIP_BOUNDARY_POLL_MS,
  );

  if (!data || !countdown) return null;

  const live = data.phase === "active";
  return (
    <Link
      href="/rewards?utm_source=homepage&utm_medium=website&utm_campaign=fee_rewards&utm_content=hero_strip"
      className={styles.campaignStrip}
      data-live={live || undefined}
      data-magnetic
      data-analytics-event="growth_link_clicked"
      data-analytics-cta="fee_rewards_campaign"
      data-analytics-content="hero_strip"
    >
      <span className={styles.campaignStripDot} aria-hidden="true" />
      <strong>First 0xZAPS fee campaign</strong>
      <span className={styles.campaignStripTime} role="timer">
        {reached
          ? `${countdown.reachedLabel} · confirming onchain`
          : `${live ? "Live · " : ""}${countdown.label} ${formatCountdown(remaining, reduced ? "minute" : "second")}`}
      </span>
      {/* The rewards app closes new stakes in claim-only; never advertise
          an action the destination refuses. */}
      <em>{data.phase === "claim-only" ? "Claim & inspect →" : "Stake & inspect →"}</em>
    </Link>
  );
}
