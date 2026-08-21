"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { RollingDigits } from "@/components/RollingDigits";
import { useCampaignCountdown } from "@/components/useCampaignCountdown";
import { TOKEN } from "@/lib/config";
import {
  campaignPhase,
  formatCountdown,
  type FeeRewardsPhase,
} from "@/lib/rewards";
import {
  CAMPAIGN_2_PULSE_MAX_AGE_MS,
  campaign2PulseIsFresh,
  FEE_REWARDS_2_MANIFEST,
} from "@/lib/rewards2";
import type { Campaign2StakingPulse } from "@/lib/rewards2-server";
import styles from "./landing.module.css";

const STRIP_BOUNDARY_POLL_MS = 30_000;
const STRIP_REFRESH_MS = 60_000;
const STRIP_RETRY_DELAY_MS = 10_000;
const STRIP_FETCH_ATTEMPTS = 2;

/**
 * Hero highlight for the live second 0xZAPS fee campaign.
 *
 * The landing page is statically prerendered, so this strip renders nothing
 * until a verified snapshot arrives at runtime and confirms a clock-bound
 * phase (upcoming, active, or claim-only). A marketing surface never invents
 * live claims: fetch failure, warming caches, and non-clock phases all fail
 * closed to the reserved empty slot rather than a synthesized countdown.
 */
export function CampaignStrip(): React.JSX.Element | null {
  const [data, setData] = useState<Campaign2StakingPulse | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    for (let attempt = 0; attempt < STRIP_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch("/api/protocol/rewards2/staking", { cache: "no-store" });
        if (mine !== sequence.current) return;
        if (response.status === 200) {
          const payload = (await response.json()) as Campaign2StakingPulse;
          if (mine !== sequence.current) return;
          setData(campaign2PulseIsFresh(payload) ? payload : null);
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
    setData((current) => current && campaign2PulseIsFresh(current) ? current : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => {
      setData((current) => current && campaign2PulseIsFresh(current) ? current : null);
      if (document.visibilityState === "visible") void load();
    }, STRIP_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      sequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const expiresAt = Math.min(
      Date.parse(data.readAt),
      Number(data.blockTimestamp) * 1_000,
    ) + CAMPAIGN_2_PULSE_MAX_AGE_MS;
    const timer = window.setTimeout(() => {
      setData((current) => current && campaign2PulseIsFresh(current) ? current : null);
    }, Math.max(0, expiresAt - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [data]);

  const resync = useCallback((): void => {
    void load();
  }, [load]);

  const term = FEE_REWARDS_2_MANIFEST.deployment.campaign;
  const campaign = data?.campaign ?? null;
  const phase: FeeRewardsPhase | null = data && campaign
    ? campaignPhase(
        BigInt(data.blockTimestamp),
        campaign.feeSharesFunded,
        campaign.finalized,
        term.startAt,
        term.endAt,
        term.claimDeadline,
      )
    : null;
  const countdownInput = data && phase
    ? { phase, blockHash: data.blockHash, blockTimestamp: data.blockTimestamp }
    : null;
  const { countdown, remaining, reached, reduced } = useCampaignCountdown(
    countdownInput,
    resync,
    STRIP_BOUNDARY_POLL_MS,
    term,
  );

  if (!data || !campaign || !phase || !countdown) return null;

  const totalSupply = BigInt(TOKEN.totalSupply) * 10n ** BigInt(TOKEN.decimals);
  const totalStaked = BigInt(campaign.totalStaked);
  if (totalStaked < 0n || totalStaked > totalSupply) return null;
  const stakedBps = Number((totalStaked * 10_000n + totalSupply / 2n) / totalSupply);
  const stakedPercent = (stakedBps / 100).toFixed(2);

  const live = phase === "active";
  return (
    <Link
      href="/rewards?campaign=2&utm_source=homepage&utm_medium=website&utm_campaign=campaign_2&utm_content=supply_staked_strip"
      className={styles.campaignStrip}
      data-live={live || undefined}
      data-magnetic
      data-analytics-event="growth_link_clicked"
      data-analytics-cta="fee_rewards_campaign"
      data-analytics-content="supply_staked_strip"
    >
      <span className={styles.campaignStripDot} aria-hidden="true" />
      <strong>Campaign 2 · {stakedPercent}% of supply staked</strong>
      <span
        className={styles.campaignStripSupply}
        role="img"
        aria-label={`${stakedPercent}% of the fixed 0xZAPS supply is staked in Campaign 2`}
      >
        <i style={{ transform: `scaleX(${Math.min(1, stakedBps / 10_000)})` }} />
      </span>
      <span className={styles.campaignStripTime} role="timer">
        {reached
          ? `${countdown.reachedLabel} · confirming onchain`
          : (
            <>
              {`${live ? "Live · " : ""}${countdown.label} `}
              <RollingDigits animate={!reduced} value={formatCountdown(remaining, reduced ? "minute" : "second")} />
            </>
          )}
      </span>
      {/* The rewards app closes new stakes in claim-only; never advertise
          an action the destination refuses. */}
      <em>{phase === "claim-only" ? "Claim & inspect →" : "Stake & inspect →"}</em>
    </Link>
  );
}
