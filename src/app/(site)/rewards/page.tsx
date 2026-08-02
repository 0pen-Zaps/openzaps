import { JsonLd } from "@/components/JsonLd";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";
import { fetchFeeRewards } from "@/lib/rewards-server";
import type { FeeRewardsPayload } from "@/lib/rewards";
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
  ],
});

export const dynamic = "force-dynamic";

type RewardsPageProps = {
  searchParams: Promise<{ workspace?: string | string[] }>;
};

function workspaceFrom(value: string | string[] | undefined): RewardsWorkspaceName {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === "operate" || candidate === "proof" ? candidate : "earn";
}

export default async function RewardsPage({ searchParams }: RewardsPageProps): Promise<React.JSX.Element> {
  const { workspace } = await searchParams;
  let initial: FeeRewardsPayload | null = null;
  try {
    initial = await fetchFeeRewards(null);
  } catch {
    // The client renders an explicit unavailable state. Zeroed campaign data
    // would be an unverified economic claim, so no fallback figures are made.
    initial = null;
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

      <RewardsWorkspace initial={initial} initialWorkspace={workspaceFrom(workspace)} />
    </main>
  );
}
