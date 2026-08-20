"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";

import {
  useCampaignCountdown,
  type CampaignCountdownTerm,
} from "@/components/useCampaignCountdown";
import {
  campaignPhase,
  campaignPhaseNote,
  formatCampaignPhase,
  formatCountdown,
  type FeeRewardsPhase,
} from "@/lib/rewards";
import type { FeeRewardsStakersPayload } from "@/lib/rewards-stakers";
import { FEE_REWARDS_2_MANIFEST, feeRewards2Deployment } from "@/lib/rewards2";
import type { Campaign2Preflight } from "@/lib/rewards2-server";
import styles from "./campaign2.module.css";

const REFRESH_MS = 60_000;
const COUNTDOWN_BOUNDARY_POLL_MS = 10_000;
const STAKER_ROW_LIMIT = 12;

type Released = {
  campaign: { startAt: bigint; endAt: bigint; claimDeadline: bigint };
  hookBlocks: { address: `0x${string}` };
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAmount(wei: string, digits = 2): string {
  const value = Number(formatUnits(BigInt(wei), 18));
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/**
 * Live campaign-2 stats: exact phase countdown, the HOOKR burn ledger, and
 * the complete-or-absent staker register — every figure from a block-pinned
 * snapshot, phase never flipped by the local clock, and any failed source
 * rendered as an explicit unavailable state instead of zeros.
 */
export function Campaign2Live(): React.JSX.Element | null {
  const released =
    feeRewards2Deployment() === "configured"
      ? (FEE_REWARDS_2_MANIFEST.deployment as unknown as Released)
      : null;

  const [preflight, setPreflight] = useState<Campaign2Preflight | null | "unavailable">(null);
  const [stakers, setStakers] = useState<FeeRewardsStakersPayload | null | "unavailable">(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    const [pre, stak] = await Promise.allSettled([
      fetch("/api/protocol/rewards2", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as Campaign2Preflight;
      }),
      fetch("/api/protocol/rewards2/stakers", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as FeeRewardsStakersPayload;
      }),
    ]);
    if (mine !== sequence.current) return;
    setPreflight(pre.status === "fulfilled" ? pre.value : "unavailable");
    setStakers(stak.status === "fulfilled" ? stak.value : "unavailable");
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const data = preflight !== null && preflight !== "unavailable" ? preflight : null;
  const term: CampaignCountdownTerm | undefined = released
    ? {
        startAt: BigInt(released.campaign.startAt),
        endAt: BigInt(released.campaign.endAt),
        claimDeadline: BigInt(released.campaign.claimDeadline),
      }
    : undefined;

  const phase: FeeRewardsPhase | null =
    data && term
      ? campaignPhase(
          BigInt(data.blockTimestamp),
          data.live?.campaign.feeSharesFunded ?? false,
          data.live?.campaign.finalized ?? false,
          term.startAt,
          term.endAt,
          term.claimDeadline,
        )
      : null;

  const countdownInput =
    data && phase !== null
      ? { phase, blockHash: data.blockHash, blockTimestamp: data.blockTimestamp }
      : null;
  const countdown = useCampaignCountdown(
    countdownInput,
    load,
    COUNTDOWN_BOUNDARY_POLL_MS,
    term,
  );

  if (!released) return null;

  const hb = data?.live?.hookBlocks ?? null;

  return (
    <section className={styles.live} aria-label="Campaign 2 live stats">
      {/* ------------------------------------------------ phase + countdown */}
      <div className={styles.liveHead}>
        <div>
          <span className={styles.liveEyebrow}>Phase</span>
          <strong>{phase ? formatCampaignPhase(phase) : "Verifying…"}</strong>
        </div>
        {countdown.countdown !== null && (
          <div className={styles.liveCountdown}>
            <span className={styles.liveEyebrow}>
              {countdown.reached ? countdown.countdown.reachedLabel : countdown.countdown.label}
            </span>
            <strong>
              {formatCountdown(countdown.remaining, countdown.reduced ? "minute" : "second")}
            </strong>
          </div>
        )}
        <div>
          <span className={styles.liveEyebrow}>Verified block</span>
          <strong>{data ? `#${data.headBlock}` : "unavailable"}</strong>
        </div>
      </div>
      {phase !== null && <p className={styles.stakeNote}>{campaignPhaseNote(phase)}</p>}

      {/* ---------------------------------------------------- burn ledger */}
      <div className={styles.burnRow}>
        <div className={styles.burnStat} data-hero>
          <span className={styles.liveEyebrow}>HOOKR burned · live</span>
          <strong>{hb ? formatAmount(hb.totalHookrBurned) : "—"}</strong>
          <span className={styles.burnSub}>
            {hb ? `${formatAmount(hb.totalHookrBought)} bought with ${formatAmount(hb.totalEthSpent, 5)} ETH` : "unavailable"}
          </span>
        </div>
        <div className={styles.burnStat}>
          <span className={styles.liveEyebrow}>Hook Blocks</span>
          <strong>{hb ? hb.blockCount : "—"}</strong>
          <span className={styles.burnSub}>immutable ledger entries</span>
        </div>
        <div className={styles.burnStat}>
          <span className={styles.liveEyebrow}>Awaiting conversion</span>
          <strong>{hb ? `${formatAmount(hb.pendingWeth, 5)} WETH` : "—"}</strong>
          <span className={styles.burnSub}>claimable + held, next crank</span>
        </div>
      </div>
      {hb && hb.recentBlocks.length > 0 && (
        <ul className={styles.blocksList} aria-label="Latest Hook Blocks">
          {hb.recentBlocks.map((entry, index) => (
            <li key={`${entry.burnedAt}-${index}`}>
              <span>#{Number(hb.blockCount) - 1 - index}</span>
              <span>{formatAmount(entry.ethIn, 5)} ETH → {formatAmount(entry.hookrBought)} HOOKR</span>
              <span>
                {new Date(Number(entry.burnedAt) * 1000).toISOString().slice(5, 16).replace("T", " ")} UTC
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* -------------------------------------------------------- stakers */}
      <div className={styles.stakersBlock}>
        <div className={styles.liveHead}>
          <div>
            <span className={styles.liveEyebrow}>Stakers</span>
            <strong>
              {stakers === "unavailable" || stakers === null
                ? stakers === null
                  ? "loading…"
                  : "unavailable"
                : `${stakers.activeStakerCount} active · ${stakers.allTimeStakerCount} all-time`}
            </strong>
          </div>
          <div>
            <span className={styles.liveEyebrow}>Total staked</span>
            <strong>
              {stakers !== null && stakers !== "unavailable"
                ? `${formatAmount(stakers.totalStaked)} 0xZAPS`
                : "—"}
            </strong>
          </div>
          <div>
            <span className={styles.liveEyebrow}>WETH earned</span>
            <strong>
              {stakers !== null && stakers !== "unavailable"
                ? formatAmount(stakers.totalEarnedWeth, 6)
                : "—"}
            </strong>
          </div>
        </div>
        {stakers === "unavailable" ? (
          <p className={styles.stakeNote}>
            The staker list is unavailable. It is complete or absent — no partial or zeroed
            list is shown; it retries on the next refresh.
          </p>
        ) : stakers !== null && stakers.stakers.length > 0 ? (
          <table className={styles.stakersTable}>
            <thead>
              <tr>
                <th>Staker</th>
                <th>Staked</th>
                <th>Weight</th>
                <th>Earned WETH</th>
              </tr>
            </thead>
            <tbody>
              {stakers.stakers.slice(0, STAKER_ROW_LIMIT).map((row) => {
                const weightShare =
                  BigInt(stakers.totalRewardWeight) > 0n
                    ? Number((BigInt(row.rewardWeight) * 10_000n) / BigInt(stakers.totalRewardWeight)) / 100
                    : 0;
                return (
                  <tr key={row.account}>
                    <td>{shortAddress(row.account)}</td>
                    <td>{formatAmount(row.stakedBalance)}</td>
                    <td>{weightShare.toFixed(2)}%</td>
                    <td>{formatAmount(row.earnedWeth, 6)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {stakers !== null && stakers !== "unavailable" && stakers.stakers.length > STAKER_ROW_LIMIT && (
          <p className={styles.stakeNote}>
            Showing the top {STAKER_ROW_LIMIT} of {stakers.stakers.length} stakers by the verified
            snapshot.
          </p>
        )}
      </div>
    </section>
  );
}
