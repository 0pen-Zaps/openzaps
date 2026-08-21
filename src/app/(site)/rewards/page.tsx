import { JsonLd } from "@/components/JsonLd";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";
import { fetchFeeRewards } from "@/lib/rewards-server";
import type { FeeRewardsPayload } from "@/lib/rewards";
import { Campaign2Panel } from "./Campaign2Panel";
import { CampaignSwitcher, selectedCampaign } from "./CampaignSwitcher";
import { RewardsGrowthPulse } from "./RewardsGrowthPulse";
import { RewardsWorkspace, type RewardsWorkspaceName } from "./RewardsWorkspace";
import styles from "./rewards.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.rewards,
  keywords: [
    "0xZAPS staking campaign",
    "0xZAPS fee rewards",
    "Clanker trading fees",
    "tokenized fee shares",
    "Robinhood Chain rewards",
    "HOOKR Hook Blocks",
    "0xZAPS campaign 2",
  ],
});

export const dynamic = "force-dynamic";

type RewardsPageProps = {
  searchParams: Promise<{ workspace?: string | string[]; campaign?: string | string[] }>;
};

function workspaceFrom(value: string | string[] | undefined): RewardsWorkspaceName {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === "stakers" || candidate === "operate" || candidate === "proof"
    ? candidate
    : "earn";
}

export default async function RewardsPage({ searchParams }: RewardsPageProps): Promise<React.JSX.Element> {
  const { workspace, campaign } = await searchParams;
  const selected = selectedCampaign(campaign, workspace);
  let initial: FeeRewardsPayload | null = null;
  try {
    initial = await fetchFeeRewards(null);
  } catch {
    // The client renders an explicit unavailable state. Zeroed campaign data
    // would be an unverified economic claim, so no fallback figures are made.
  }

  return (
    <main className={styles.screen} id="main" data-screen-label="Fee rewards">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.rewards),
            breadcrumbJsonLd("/rewards", "0xZAPS fee rewards"),
          ],
        }}
      />

      <CampaignSwitcher selected={selected} initial={initial} />

      {selected === "1" ? (
        <RewardsWorkspace initial={initial} initialWorkspace={workspaceFrom(workspace)} />
      ) : (
        <>
          <RewardsGrowthPulse initial={null} />
          <Campaign2Panel />
        </>
      )}
    </main>
  );
}
