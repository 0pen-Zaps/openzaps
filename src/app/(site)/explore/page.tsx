import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { TokenUtilityPanel } from "@/components/TokenUtilityPanel";
import { ActivityFeed } from "./ActivityFeed";
import { fetchProtocolActivity } from "@/lib/activity-server";
import { TOKEN_LAUNCH } from "@/lib/config";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_LIQUIDITY,
  explorerAddress,
  explorerTransaction,
} from "@/lib/robinhood";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { fetchRangeVaultPulse, fetchZapVaultPulse, formatPulseAmount } from "@/lib/vault-server";
import { fetchZapSummaries } from "@/lib/zap-server";
import styles from "./explore.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.explore,
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

// Both reads are server-rendered so the SEO-relevant numbers and the Zap
// list are in the crawlable HTML; the activity client then polls for freshness.
// 5 minutes of ISR keeps it current without a read per visitor. Literal only:
// Next 16 rejects an expression here at build time.
export const revalidate = 300;

export default async function ZapsFeedPage(): Promise<React.JSX.Element> {
  // Both reads fail closed and independently. A thrown RPC read must never
  // become an empty list or a zeroed feed, because either would be a claim —
  // "the factory has deployed nothing", "nothing has happened onchain" — and
  // both would be false. Run them together; the slower one sets the wall time.
  const [activity, page, rangeVault, zapVault] = await Promise.all([
    fetchProtocolActivity().catch(() => null),
    fetchZapSummaries().catch(() => null),
    fetchRangeVaultPulse().catch(() => null),
    fetchZapVaultPulse().catch(() => null),
  ]);

  return (
    <main className={styles.screen} data-screen-label="Explore" id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd({ ...STATIC_PAGE_SEO.explore, type: "CollectionPage" }),
            breadcrumbJsonLd("/explore", "Explore"),
          ],
        }}
      />

      <section className={styles.hero}>
        <div>
          <h1 className={styles.heroTitle}>Explore every DeFi Zap, straight from the chain.</h1>
          <p className={styles.heroLede}>
            Creations, Zaps, AutoZaps, and recoveries are read directly from Robinhood Chain logs. An execution
            counts only when the Zap contract that emitted it was deployed by one of the canonical factories. No
            indexer, no estimates.
          </p>
        </div>
        <aside className={styles.heroCard}>
          <span className={styles.heroCardLabel}>Pinned pool</span>
          <strong className={styles.heroCardName}>aeWETH ↔ 0xZAPS · v4 · 2% hook</strong>
          <code className={styles.heroCardId}>
            {ROBINHOOD_LIQUIDITY.poolId.slice(0, 18)}…{ROBINHOOD_LIQUIDITY.poolId.slice(-8)}
          </code>
        </aside>
      </section>

      {/* Vault pulse: measured onchain state of the two vaults, server-read
          inside this page's ISR window. Each card fails closed to an explicit
          "unavailable" — a zero here would be a claim, and a false one. No
          yield, APR, or USD figures on purpose: the range vault earns pool
          fees it does not project, and the ozUSDG vault earns nothing.

          An unavailable card is drawn identically to a successful one; the
          `data-unavailable` attribute is the machine-readable version of that
          state, so a smoke test can assert no card quietly rendered a zero. */}
      <section className={styles.pulseGrid} aria-label="Vault pulse, read onchain">
        <div className={styles.pulseCard} data-unavailable={rangeVault === null}>
          {rangeVault === null ? (
            <>
              <strong>unavailable</strong>
              <span>ozRANGE holdings — RPC read failed</span>
            </>
          ) : (
            <>
              <strong>
                {formatPulseAmount(rangeVault.holdings[0], 18)} aeWETH · {formatPulseAmount(rangeVault.holdings[1], 6)}{" "}
                USDG
              </strong>
              <span>what all ozRANGE shares redeem for at the current pool price</span>
            </>
          )}
        </div>
        <div className={styles.pulseCard} data-unavailable={rangeVault === null}>
          {rangeVault === null ? (
            <>
              <strong>unavailable</strong>
              <span>ozRANGE shares — RPC read failed</span>
            </>
          ) : (
            <>
              <strong>
                {formatPulseAmount(rangeVault.totalShares, 18, 8)}
                {rangeVault.totalShares > 0n
                  ? ` · ${Number((rangeVault.burnedShares * 1000n) / rangeVault.totalShares) / 10}% burned`
                  : ""}
              </strong>
              <span>ozRANGE shares · the burned portion is the permanent seed</span>
            </>
          )}
        </div>
        <div className={styles.pulseCard} data-unavailable={rangeVault === null}>
          {rangeVault === null ? (
            <>
              <strong>unavailable</strong>
              <span>position liquidity — RPC read failed</span>
            </>
          ) : (
            <>
              <strong>{rangeVault.positionLiquidity.toLocaleString("en-US")}</strong>
              <span>full-range position liquidity (pool L units)</span>
            </>
          )}
        </div>
        <div className={styles.pulseCard} data-unavailable={zapVault === null}>
          {zapVault === null ? (
            <>
              <strong>unavailable</strong>
              <span>ozUSDG vault — RPC read failed</span>
            </>
          ) : (
            <>
              <strong>{formatPulseAmount(zapVault.totalAssets, 6)} USDG</strong>
              <span>ozUSDG receipt vault · a wrapper, it earns nothing</span>
            </>
          )}
        </div>
      </section>

      {/* Live totals + the polling activity feed. */}
      <ActivityFeed initial={activity} />

      {/* Every Zap the factory deployed, newest first. */}
      <section className={styles.card} aria-label="Deployed Zaps">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Deployed Zaps</h2>
          <span className={styles.cardSub}>
            {page === null
              ? "unavailable — the log query failed"
              : page.rows.length === 0
                ? "no Zap has been deployed yet"
                : page.truncated
                  ? `showing the newest ${page.rows.length} of ${page.total} Zaps`
                  : `${page.total === 1 ? "1 Zap" : `${page.total} Zaps`}, newest first`}
          </span>
          <span className={styles.cardHeadEnd}>
            <a
              className={styles.headLink}
              href={explorerAddress(OPENZAP_CONTRACTS.factory)}
              target="_blank"
              rel="noreferrer"
            >
              Factory ↗
            </a>
            {page !== null && (
              <span className={styles.liveChip}>
                <i className={styles.liveDot} />
                re-read every 5 min
              </span>
            )}
          </span>
        </div>

        {page === null ? (
          <div className={styles.unavailable} role="alert">
            <p>
              The Robinhood RPC log query failed, so this list is unavailable. An empty list would be a claim that the
              canonical factories have deployed nothing. Nothing is shown instead.
            </p>
            <a
              className={styles.ghostBtn}
              href={explorerAddress(OPENZAP_CONTRACTS.factory)}
              target="_blank"
              rel="noreferrer"
            >
              Read the v1.1 factory directly ↗
            </a>
          </div>
        ) : page.rows.length === 0 ? (
          <p className={styles.empty}>No Zap has been deployed yet. The first factory creation will appear here.</p>
        ) : (
          <ol className={styles.zapList}>
            {page.rows.map((zap, i) => (
              <li
                className={styles.zapRow}
                key={zap.address}
                style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
              >
                <Link className={styles.zapLink} href={`/explore/${zap.address}`}>
                  <code className={styles.zapAddress}>{shortAddress(zap.address)}</code>
                </Link>
                <span className={styles.zapMeta}>
                  owner {shortAddress(zap.owner)} · {zap.lineage} · policy {shortHex(zap.policyHash)}
                </span>
                <span className={styles.zapRuns} data-active={zap.executionCount > 0}>
                  {zap.executionCount === 1 ? "1 Zap" : `${zap.executionCount} Zaps`}
                </span>
                <span className={styles.zapTime} suppressHydrationWarning>
                  {/* Rendered in the server's timezone (UTC on Vercel) and again in
                      the visitor's, so the text legitimately differs across
                      hydration and React must be told not to treat it as a mismatch. */}
                  {zap.createdAt
                    ? `created ${localDate(zap.createdAt)}`
                    : `created in block ${Number(zap.createdBlock).toLocaleString("en-US")}`}
                </span>
                <a
                  className={styles.zapTx}
                  href={explorerTransaction(zap.createdTx)}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </a>
              </li>
            ))}
          </ol>
        )}

        <p className={styles.cardFoot}>
          An address reaches this list one way: a canonical factory&apos;s own ZapCreated log names it — v1.1, v3, or
          v3.1. What a Zap does is stored in the Zap, not here — open a row to read the policy it committed to and the
          Executed and EmergencyExit logs it has emitted.
          {page?.truncated
            ? " The rest are onchain and readable from the factories. This page does not list them."
            : ""}
        </p>
      </section>

      {/* The verified contract set. */}
      <section className={styles.card} aria-label="Verified contracts">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Verified contracts</h2>
          <span className={styles.cardSub}>source-verified on Robinhood Blockscout</span>
        </div>
        <div className={styles.contractGrid}>
          {contractRows.map(([label, address]) => (
            <a
              className={styles.contractCell}
              href={explorerAddress(address)}
              key={label}
              target="_blank"
              rel="noreferrer"
            >
              <span className={styles.contractLabel}>{label}</span>
              <code className={styles.contractAddress}>{address}</code>
            </a>
          ))}
        </div>
        <p className={styles.cardFoot}>
          Six source-verified contracts on Robinhood Blockscout. The expansion adapters and the v3 / v3.1 automation
          factories are deployed alongside them; their addresses are not listed on this page.
        </p>
        <p className={styles.cardFoot}>
          Depositing funds can result in total loss. Onchain actions are irreversible.{" "}
          <Link href="/docs#security">Read the security model</Link>.
        </p>
      </section>

      {/* Marketing copy rather than chain data, so it sits after everything the
          page actually read. */}
      <TokenUtilityPanel id="token-utility" />
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
