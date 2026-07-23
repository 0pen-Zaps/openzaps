import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { ActivityFeed } from "./ActivityFeed";
import { fetchProtocolActivity } from "@/lib/activity-server";
import { TOKEN_LAUNCH } from "@/lib/config";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_LIQUIDITY,
  explorerAddress,
  explorerTransaction,
} from "@/lib/robinhood";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { fetchZapSummaries } from "@/lib/zap-server";
import feed from "./feed.module.css";
import styles from "./zaps.module.css";

export const metadata = pageMetadata({
  title: "Zaps Feed — live activity and every deployed capsule",
  description:
    "The live OpenZaps feed on Robinhood Chain: creations, executions, and recoveries read straight from onchain logs, every policy capsule the canonical factory deployed, and the verified contract set — one page, no indexer, no estimates.",
  path: "/zaps",
  keywords: [
    "OpenZaps feed",
    "Robinhood Chain activity",
    "deployed zaps",
    "OpenZaps capsules",
    "live zap transactions",
    "0xZAPS onchain activity",
    "zap explorer",
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

// Both reads are server-rendered so the SEO-relevant numbers and the capsule
// list are in the crawlable HTML; the activity client then polls for freshness.
// 5 minutes of ISR keeps it current without a read per visitor. Literal only:
// Next 16 rejects an expression here at build time.
export const revalidate = 300;

export default async function ZapsFeedPage(): Promise<React.JSX.Element> {
  // Both reads fail closed and independently. A thrown RPC read must never
  // become an empty list or a zeroed feed, because either would be a claim —
  // "the factory has deployed nothing", "nothing has happened onchain" — and
  // both would be false. Run them together; the slower one sets the wall time.
  const [activity, page] = await Promise.all([
    fetchProtocolActivity().catch(() => null),
    fetchZapSummaries().catch(() => null),
  ]);

  return (
    <main className={feed.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/zaps", "Zaps Feed") }} />

      <section className={`container ${feed.hero}`}>
        <div>
          <span className="eyebrow">Zaps Feed</span>
          <h1>Every zap, straight from the chain.</h1>
          <p>
            Creations, executions, and recoveries are read directly from Robinhood Chain logs — and an execution row
            is counted only when it comes from a zap the canonical factory deployed. Below the live feed sits every
            capsule the factory created, and the verified contract set behind them. No indexer, no estimates.
          </p>
          <div className={feed.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/build">
              Design a chain
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
        <aside className={feed.heroCard}>
          <span>Pinned pool</span>
          <strong>aeWETH ↔ 0xZAPS · v4 · 2% hook</strong>
          <code>{ROBINHOOD_LIQUIDITY.poolId.slice(0, 18)}…{ROBINHOOD_LIQUIDITY.poolId.slice(-8)}</code>
        </aside>
      </section>

      {/* Live totals + the polling activity feed. */}
      <ActivityFeed initial={activity} />

      {/* Every capsule the factory deployed, newest first. */}
      <section className={`container ${styles.panel}`} aria-label="Deployed capsules">
        <div className={styles.listHead}>
          <span className="eyebrow">Deployed capsules</span>
          {page === null ? (
            <h2>Deployed by the factory, or not listed.</h2>
          ) : page.rows.length === 0 ? (
            <h2>No capsule has been deployed yet.</h2>
          ) : (
            <h2>
              {page.truncated
                ? `Showing the newest ${page.rows.length} of ${page.total} capsules.`
                : `${page.total === 1 ? "1 capsule" : `${page.total} capsules`}, newest first.`}
            </h2>
          )}
          <p>
            An address reaches this list one way: the canonical factory&apos;s own ZapCreated log names it. What a
            capsule does is stored in the capsule, not here — open a row to read the policy it committed to and every
            execution it has logged.
            {page?.truncated
              ? " The rest are onchain and readable from the factory. This page does not list them."
              : ""}
          </p>
        </div>

        {page === null ? (
          <div className={styles.unavailable} role="alert">
            <p>
              The Robinhood RPC log query failed, so this list is unavailable. An empty list would be a claim that the
              factory has deployed nothing. Nothing is shown instead.
            </p>
            <a
              className="btn btnGhost"
              href={explorerAddress(OPENZAP_CONTRACTS.factory)}
              target="_blank"
              rel="noreferrer"
            >
              <span>Read the factory directly ↗</span>
            </a>
          </div>
        ) : page.rows.length === 0 ? (
          <p className={styles.empty}>No capsule has been deployed yet. The first factory creation will appear here.</p>
        ) : (
          <ol className={styles.list}>
            {page.rows.map((zap, i) => (
              <li className={styles.listItem} key={zap.address} style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}>
                <Link className={styles.listLink} href={`/zaps/${zap.address}`}>
                  <code className={styles.listAddress}>{shortAddress(zap.address)}</code>
                  <span className={styles.listOwner}>owner {shortAddress(zap.owner)}</span>
                  <span className={styles.listPolicy}>policy {shortHex(zap.policyHash)}</span>
                  <span className={styles.listRuns} data-active={zap.executionCount > 0}>
                    {zap.executionCount === 1 ? "1 execution" : `${zap.executionCount} executions`}
                  </span>
                  <span className={styles.listTime} suppressHydrationWarning>
                    {/* Rendered in the server's timezone (UTC on Vercel) and again in
                        the visitor's, so the text legitimately differs across
                        hydration and React must be told not to treat it as a mismatch. */}
                    {zap.createdAt
                      ? `created ${localDate(zap.createdAt)}`
                      : `created in block ${Number(zap.createdBlock).toLocaleString("en-US")}`}
                  </span>
                </Link>
                <a
                  className={styles.listTx}
                  href={explorerTransaction(zap.createdTx)}
                  target="_blank"
                  rel="noreferrer"
                >
                  creation tx ↗
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* The verified contract set. */}
      <section className={`container ${feed.section}`}>
        <header className={feed.head}>
          <span className="eyebrow">Verified contracts</span>
          <h2>The complete deployed set.</h2>
          <p>Six contracts, all source-verified on Robinhood Blockscout. Nothing else holds protocol authority.</p>
        </header>
        <div className={feed.contractGrid}>
          {contractRows.map(([label, address]) => (
            <a className={feed.contractRow} href={explorerAddress(address)} key={label} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <code>{address}</code>
            </a>
          ))}
        </div>
        <p className={feed.note}>
          The contracts have not been externally audited. Depositing funds can result in total loss. Onchain actions
          are irreversible.{" "}
          <Link href="/docs#security">Read the security model</Link>.
        </p>
      </section>
    </main>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHex(hex: string): string {
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function localDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", { dateStyle: "medium" });
}
