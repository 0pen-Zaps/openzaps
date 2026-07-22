import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { DashboardActivity, type ActivityPayload } from "./DashboardActivity";
import { fetchProtocolActivity } from "@/lib/activity-server";
import { TOKEN_LAUNCH } from "@/lib/config";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_LIQUIDITY,
  explorerAddress,
} from "@/lib/robinhood";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import styles from "./dashboard.module.css";

export const metadata = pageMetadata({
  title: "Dashboard — live protocol activity",
  description:
    "Live OpenZaps activity on Robinhood Chain: zap creations, executions, and recoveries read directly from onchain logs, plus the verified contract set.",
  path: "/dashboard",
  keywords: [
    "OpenZaps dashboard",
    "Robinhood Chain activity",
    "live zap transactions",
    "0xZAPS onchain activity",
    "DeFi policy execution log",
  ],
});

const contractRows = [
  ["Factory", OPENZAP_CONTRACTS.factory],
  ["Implementation", OPENZAP_CONTRACTS.implementation],
  ["Swap adapter", OPENZAP_CONTRACTS.adapter],
  ["Adapter registry", OPENZAP_CONTRACTS.adapterRegistry],
  ["Token allowlist", OPENZAP_CONTRACTS.tokenAllowlist],
  ["0xZAPS token", TOKEN_LAUNCH.contract],
] as const;

// Server-render the live stats and feed so the SEO-relevant numbers are in the
// crawlable HTML; the client component then polls for freshness. Regenerated
// every 5 minutes via ISR; a failed fetch falls back to client-only loading.
export const revalidate = 300;

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const initial: ActivityPayload | null = await fetchProtocolActivity().catch(() => null);
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/dashboard", "Dashboard") }} />

      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Live dashboard</span>
          <h1>Every zap, straight from the chain.</h1>
          <p>
            Creations, executions, and recoveries are read directly from Robinhood Chain logs — and execution rows
            are only counted when they come from a zap the canonical factory deployed. No indexer, no estimates.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/app">
              Open the app
            </Link>
            <a
              className="btn btnGhost btnLg"
              href={explorerAddress(OPENZAP_CONTRACTS.factory)}
              target="_blank"
              rel="noreferrer"
            >
              Factory on Blockscout ↗
            </a>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>Pinned pool</span>
          <strong>aeWETH ↔ 0xZAPS · v4 · 2% hook</strong>
          <code>{ROBINHOOD_LIQUIDITY.poolId.slice(0, 18)}…{ROBINHOOD_LIQUIDITY.poolId.slice(-8)}</code>
        </aside>
      </section>

      <DashboardActivity initial={initial} />

      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">Verified contracts</span>
          <h2>The complete deployed set.</h2>
          <p>Six contracts, all source-verified on Robinhood Blockscout. Nothing else holds protocol authority.</p>
        </header>
        <div className={styles.contractGrid}>
          {contractRows.map(([label, address]) => (
            <a className={styles.contractRow} href={explorerAddress(address)} key={label} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <code>{address}</code>
            </a>
          ))}
        </div>
        <p className={styles.note}>
          Contracts are live but pre-external-audit. Depositing funds can result in total loss —{" "}
          <Link href="/security">read the security posture</Link>.
        </p>
      </section>
    </main>
  );
}
