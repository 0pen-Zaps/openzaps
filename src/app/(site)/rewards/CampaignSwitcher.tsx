import Link from "next/link";

import { formatCampaignPhase, type FeeRewardsPayload } from "@/lib/rewards";
import { feeRewards2Deployment } from "@/lib/rewards2";
import styles from "./campaigns.module.css";

export type CampaignId = "1" | "2";

/**
 * Which campaign the page should show. Explicit `?campaign=` wins; a
 * `?workspace=` deep link predates the switcher and always meant campaign 1;
 * otherwise the default is manifest-driven — campaign 2 the moment its
 * reviewed release is configured, campaign 1 until then. No clock, no RPC:
 * the default flips only when a source change fills the manifest.
 */
export function selectedCampaign(
  campaign: string | string[] | undefined,
  workspace: string | string[] | undefined,
): CampaignId {
  const candidate = Array.isArray(campaign) ? campaign[0] : campaign;
  if (candidate === "1" || candidate === "2") return candidate;
  if (workspace !== undefined) return "1";
  return feeRewards2Deployment() === "configured" ? "2" : "1";
}

/**
 * The campaigns index: one compact card per campaign so the two are clearly
 * separate things with separate windows, states, and detail views. Selection
 * is a plain link (server-rendered, no client JS); the selected campaign's
 * full detail renders below.
 */
export function CampaignSwitcher({
  selected,
  initial,
}: {
  selected: CampaignId;
  initial: FeeRewardsPayload | null;
}): React.JSX.Element {
  // Fail closed on the live chip: a missing snapshot renders "Unavailable",
  // never a guessed phase.
  const phase1 = initial ? formatCampaignPhase(initial.phase) : "Unavailable";
  // Green only while stakers can still act (staking open or claims open).
  const actionable1 = initial?.phase === "active" || initial?.phase === "claim-only";
  const live2 = feeRewards2Deployment() === "configured";

  return (
    <nav className={styles.switcher} aria-label="Campaigns">
      <Link
        href="/rewards?campaign=1"
        className={styles.card}
        data-selected={selected === "1" ? "" : undefined}
        aria-current={selected === "1" ? "page" : undefined}
      >
        <span className={styles.cardEyebrow}>Campaign 1 · Aug 3 – 10, 2026</span>
        <strong className={styles.cardTitle}>Fee rewards for 0xZAPS stakers</strong>
        <span className={styles.cardMeta}>
          <i aria-hidden data-live={actionable1 ? "" : undefined} />
          {phase1} · 50 of 100 fee shares · claims close Sep 9
        </span>
      </Link>

      <Link
        href="/rewards?campaign=2"
        className={styles.card}
        data-selected={selected === "2" ? "" : undefined}
        aria-current={selected === "2" ? "page" : undefined}
      >
        <span className={styles.cardEyebrow}>Campaign 2 · 14 days</span>
        <strong className={styles.cardTitle}>Stakers + HOOKR buy-and-burn</strong>
        <span className={styles.cardMeta}>
          <i aria-hidden data-live={live2 ? "" : undefined} />
          {live2 ? "Live" : "Announced — not live yet"} · all 100 fee shares, 50 to each leg
        </span>
      </Link>
    </nav>
  );
}
