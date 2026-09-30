import Link from "next/link";

import { formatCampaignPhase, type FeeRewardsPayload } from "@/lib/rewards";
import { feeRewards2Deployment } from "@/lib/rewards2";
import { feeRewards3Deployment } from "@/lib/rewards3";
import styles from "./campaigns.module.css";

export type CampaignId = "1" | "2" | "3";

/**
 * Which campaign the page should show. Explicit `?campaign=` wins; a
 * `?workspace=` deep link predates the switcher and still means campaign 1.
 * Otherwise, prefer the newest fully configured release, never a clock-based
 * guess. An announced campaign remains selectable but cannot become default.
 */
export function selectedCampaign(
  campaign: string | string[] | undefined,
  workspace: string | string[] | undefined,
): CampaignId {
  const candidate = Array.isArray(campaign) ? campaign[0] : campaign;
  if (candidate === "1" || candidate === "2" || candidate === "3") return candidate;
  if (workspace !== undefined) return "1";
  if (feeRewards3Deployment() === "configured") return "3";
  return feeRewards2Deployment() === "configured" ? "2" : "1";
}

/** One compact, consistent card per campaign; the selected detail renders below. */
export function CampaignSwitcher({
  selected,
  initial,
}: {
  selected: CampaignId;
  initial: FeeRewardsPayload | null;
}): React.JSX.Element {
  // A missing Campaign 1 snapshot is unavailable, never a guessed phase.
  const phase1 = initial ? formatCampaignPhase(initial.phase) : "Unavailable";
  const actionable1 = initial?.phase === "active" || initial?.phase === "claim-only";
  const release2 = feeRewards2Deployment();
  const release3 = feeRewards3Deployment();

  const campaigns: readonly {
    id: CampaignId;
    eyebrow: string;
    title: string;
    meta: string;
    live: boolean;
  }[] = [
    {
      id: "1",
      eyebrow: "Campaign 1 · Aug 3–10, 2026",
      title: "Fee rewards for 0xZAPS stakers",
      meta: `${phase1} · 50 of 100 fee shares · claims close Sep 9`,
      live: actionable1,
    },
    {
      id: "2",
      eyebrow: "Campaign 2 · 14 days",
      title: "Stakers + HOOKR buy-and-burn",
      meta: `${release2 === "configured" ? "Contracts released · phase in details" : "Announced — not live yet"} · 50/50 fee-share split`,
      live: false,
    },
    {
      id: "3",
      eyebrow: "Campaign 3 · Oct 1–31, 2026 UTC",
      title: "Stakers + HOOKR buy-and-burn",
      meta: `${release3 === "configured" ? "Deployment recorded — controls disabled" : release3 === "partial" ? "Release error — controls disabled" : "Prepared — not live yet"} · 31 days · 50/50 fee-share split`,
      live: false,
    },
  ];

  return (
    <nav className={styles.switcher} aria-label="Campaigns">
      {campaigns.map((campaign) => (
        <Link
          key={campaign.id}
          href={`/rewards?campaign=${campaign.id}`}
          prefetch={false}
          className={styles.card}
          data-selected={selected === campaign.id ? "" : undefined}
          aria-current={selected === campaign.id ? "page" : undefined}
        >
          <span className={styles.cardEyebrow}>{campaign.eyebrow}</span>
          <strong className={styles.cardTitle}>{campaign.title}</strong>
          <span className={styles.cardMeta}>
            <i aria-hidden data-live={campaign.live ? "" : undefined} />
            {campaign.meta}
          </span>
        </Link>
      ))}
    </nav>
  );
}
