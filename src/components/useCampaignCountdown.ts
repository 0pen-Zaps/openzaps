"use client";

import { useEffect, useRef, useState } from "react";

import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import { campaignCountdown, type CampaignCountdown, type FeeRewardsPayload } from "@/lib/rewards";

export const COUNTDOWN_CALM_TICK_MS = 30_000;
/** Accelerated resyncs after a boundary before decimating to the slow cadence. */
export const COUNTDOWN_FAST_POLL_LIMIT = 18;
export const COUNTDOWN_SLOW_POLL_MS = 60_000;

export type CampaignCountdownState = {
  countdown: CampaignCountdown | null;
  /** Estimated seconds until the countdown target; 0n when there is no target. */
  remaining: bigint;
  /** True once the estimate crosses the boundary while verified state has not moved. */
  reached: boolean;
  /** Calm/reduced motion: minute granularity, slow tick. */
  reduced: boolean;
};

/**
 * Live time-to-boundary estimate for the verified campaign snapshot.
 *
 * The estimate is anchored to the payload's verified block timestamp plus a
 * locally measured monotonic delta since that payload arrived. Phase never
 * flips from the local clock: once the boundary passes, `reached` turns true
 * and `onResync` is invoked so the caller can refetch until verified state
 * moves. `onResync` also fires when the tab becomes visible again, so a
 * resumed machine re-verifies instead of trusting a clock that slept.
 */
export function useCampaignCountdown(
  data: FeeRewardsPayload | null,
  onResync: () => void,
  boundaryPollMs: number,
): CampaignCountdownState {
  const reduced = useReducedMotionPreference();
  const countdown = data ? campaignCountdown(data.phase) : null;
  const blockHash = data?.blockHash ?? null;
  const hasCountdown = countdown !== null && blockHash !== null;

  // Elapsed seconds tagged with the payload block they were measured against.
  // A queued tick from an outgoing interval can fire between a new payload's
  // commit and the effect flush; its stale write identifies itself by block
  // tag and derives to 0n instead of stomping the new payload's clock.
  const [tick, setTick] = useState<{ block: string; seconds: bigint } | null>(null);
  const elapsed = tick !== null && tick.block === blockHash ? tick.seconds : 0n;
  const anchorRef = useRef<{ block: string; at: number } | null>(null);

  useEffect(() => {
    if (!hasCountdown || blockHash === null) return;
    // performance.now() is monotonic: a wall-clock NTP step cannot fake a
    // boundary crossing. If the monotonic clock pauses across a system
    // suspend the countdown briefly overstates remaining time — the safe
    // direction — until the visibility resync below refetches. The anchor
    // ref is keyed by block so a calm/cinematic toggle re-runs this effect
    // without moving the measurement origin.
    if (anchorRef.current?.block !== blockHash) {
      anchorRef.current = { block: blockHash, at: performance.now() };
    }
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      setTick({
        block: anchor.block,
        seconds: BigInt(Math.max(0, Math.floor((performance.now() - anchor.at) / 1000))),
      });
    }, reduced ? COUNTDOWN_CALM_TICK_MS : 1_000);
    return () => window.clearInterval(timer);
  }, [blockHash, hasCountdown, reduced]);

  const remaining = countdown && data
    ? countdown.target - (BigInt(data.blockTimestamp) + elapsed)
    : 0n;
  const reached = hasCountdown && remaining <= 0n;

  useEffect(() => {
    if (!reached) return;
    // Every client crosses the same onchain boundary near-simultaneously, so
    // the immediate resync is gated to visible tabs and the cadence carries
    // ±10% jitter — otherwise thousands of open tabs would phase-lock their
    // fetches into synchronized waves at exactly the busiest moment.
    if (!document.hidden) onResync();
    // Accelerated polling is bounded: after COUNTDOWN_FAST_POLL_LIMIT visible
    // polls the same interval decimates to the steady 60s cadence, so a
    // halted chain or failing endpoint sees a short burst, not a hammer, and
    // connected viewers stay inside the API's per-minute budget.
    let polls = 0;
    const slowEvery = Math.max(1, Math.round(COUNTDOWN_SLOW_POLL_MS / boundaryPollMs));
    const jitteredPollMs = Math.round(boundaryPollMs * (0.9 + Math.random() * 0.2));
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      polls += 1;
      if (polls > COUNTDOWN_FAST_POLL_LIMIT && polls % slowEvery !== 0) return;
      onResync();
    }, jitteredPollMs);
    return () => window.clearInterval(timer);
  }, [reached, onResync, boundaryPollMs]);

  useEffect(() => {
    if (!hasCountdown) return;
    const onVisible = (): void => {
      if (!document.hidden) onResync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [hasCountdown, onResync]);

  return { countdown, remaining, reached, reduced };
}
