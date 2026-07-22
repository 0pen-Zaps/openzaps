import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { OPENZAP_CONTRACTS, explorerAddress, explorerTransaction } from "@/lib/robinhood";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { fetchZapSummaries } from "@/lib/zap-server";
import type { ZapSummaryPage } from "@/lib/zap";
import styles from "./zaps.module.css";

export const metadata = pageMetadata({
  title: "Deployed zaps — every capsule the factory created",
  description:
    "Every OpenZap policy capsule the canonical factory deployed on Robinhood Chain, newest first, listed only from its own ZapCreated logs. Open one to read the policy it stores and every execution it has logged.",
  path: "/zaps",
  keywords: [
    "deployed zaps",
    "OpenZaps capsules",
    "Robinhood Chain policy capsules",
    "onchain zap registry",
    "zap explorer",
  ],
});

// The list changes only when someone deploys a capsule, so 5 minutes of ISR
// keeps it crawlable and current without a read per visitor. Literal only:
// Next 16 rejects an expression here at build time.
export const revalidate = 300;

export default async function ZapsIndexPage(): Promise<React.JSX.Element> {
  // Fail closed. A thrown RPC read must never become an empty list, because an
  // empty list is a claim — "the factory has deployed nothing" — and that claim
  // would be false.
  const page: ZapSummaryPage | null = await fetchZapSummaries().catch(() => null);

  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/zaps", "Deployed zaps") }} />

      <section className={`container ${styles.hero}`}>
        <span className="eyebrow">Deployed zaps</span>
        <h1>Deployed by the factory, or not listed.</h1>
        <p>
          An address reaches this list one way: the canonical OpenZaps factory&apos;s own ZapCreated log on
          Robinhood Chain names it. Nothing else puts one here. Each row is an immutable contract holding a
          policy that was committed to a hash before it could run at all.
        </p>
        <p className={styles.heroNote}>
          What a capsule does is stored in the capsule, not in this list, and this page does not guess at it.
          Open a row to read the deployed policy drawn as a chain, the integrity checks against it, and every
          execution it has logged.
        </p>
        <div className={styles.heroActions}>
          <Link className="btn btnPrimary btnLg" href="/build">
            <span>Design a chain</span>
          </Link>
          <a
            className="btn btnGhost btnLg"
            href={explorerAddress(OPENZAP_CONTRACTS.factory)}
            target="_blank"
            rel="noreferrer"
          >
            <span>Factory on Blockscout ↗</span>
          </a>
        </div>
      </section>

      <section className={`container ${styles.panel}`} aria-label="Deployed capsules">
        {page === null ? (
          <div className={styles.unavailable} role="alert">
            <p>
              The Robinhood RPC log query failed, so this list is unavailable. An empty list would be a claim
              that the factory has deployed nothing. Nothing is shown instead.
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
          <p className={styles.empty}>
            No capsule has been deployed yet. The first factory creation will appear here.
          </p>
        ) : (
          <>
            <div className={styles.listHead}>
              {/* The heading states a count, so it has to distinguish how many
                  capsules are on screen from how many exist. Printing the row
                  count as the total would be a false number the moment the
                  factory passes the page limit. */}
              <h2>
                {page.truncated
                  ? `Showing the newest ${page.rows.length} of ${page.total} capsules.`
                  : `${page.total === 1 ? "1 capsule" : `${page.total} capsules`}, newest first.`}
              </h2>
              <p>
                Counted from ZapCreated logs emitted by the canonical factory, and from nothing else.
                {page.truncated
                  ? " The rest are onchain and readable from the factory. This page does not list them."
                  : ""}
              </p>
            </div>
            <ol className={styles.list}>
              {page.rows.map((zap, i) => (
                <li className={styles.listItem} key={zap.address} style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}>
                  <Link className={styles.listLink} href={`/zaps/${zap.address}`}>
                    <code className={styles.listAddress}>{shortAddress(zap.address)}</code>
                    <span className={styles.listOwner}>
                      owner {shortAddress(zap.owner)}
                    </span>
                    <span className={styles.listPolicy}>
                      policy {shortHex(zap.policyHash)}
                    </span>
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
          </>
        )}

        <p className={styles.note}>
          The contracts have not been externally audited. Depositing funds can result in total loss. Onchain
          actions are irreversible.{" "}
          <Link href="/security">Read the security posture</Link>.
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
