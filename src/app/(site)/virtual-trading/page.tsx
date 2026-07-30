import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { VirtualTradingDesk } from "./VirtualTradingDesk";
import styles from "./virtual-trading.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.virtualTrading,
  keywords: [
    "virtual DeFi trading",
    "paper trading for agents",
    "0xZAPS paper trading",
    "Robinhood Chain simulation",
    "virtual USDG portfolio",
  ],
});

export default function VirtualTradingPage(): React.JSX.Element {
  return (
    <main className={styles.screen} id="main" data-screen-label="Virtual Trading">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.virtualTrading),
            breadcrumbJsonLd("/virtual-trading", "Virtual Trading"),
          ],
        }}
      />

      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>VIRTUAL · LOCAL · UNRANKED</span>
          <h1 className={styles.title}>Trade the route. Risk nothing.</h1>
          <p className={styles.lede}>
            Practice exact-input trades across OpenZaps&apos; deployed USDG routes with 10,000 virtual USDG.
            Every quote is an <code>eth_call</code>{" "}accepted only while Robinhood Chain&apos;s canonical head
            number and hash stay unchanged. Every fill stays in this browser.
          </p>
        </div>
        <aside className={styles.boundary} aria-label="Virtual trading boundaries">
          <strong>Nothing here can move money.</strong>
          <span>No wallet required</span>
          <span>No deposit or approval</span>
          <span>No signature or transaction</span>
          <span>No rewards or ranked leaderboard</span>
        </aside>
      </header>

      <VirtualTradingDesk />

      <section className={styles.method} aria-labelledby="practice-method">
        <div>
          <span className={styles.sectionLabel}>PRACTICE METHOD · V1</span>
          <h2 id="practice-method">A transparent sandbox before a league.</h2>
        </div>
        <div className={styles.methodGrid}>
          <article>
            <span>01</span>
            <h3>Canonical-head route quotes</h3>
            <p>
              Buys and sells use the same four pinned USDG routes as the live policy catalog. A moving or
              same-height-changed head rejects the entire quote and retries.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Fixed-point accounting</h3>
            <p>
              Cash, cost basis, positions, turnover, NAV, and PnL use integer token units. A missing mark is
              unavailable, never silently valued at zero. NAV quotes the full 0xZAPS position into aeWETH,
              combines held aeWETH, then quotes that joint position into USDG at one canonical head. Per-market
              exits are standalone comparisons, not additive.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Local, not ranked</h3>
            <p>
              This device owns the practice ledger. Fixed epochs, shared settlement ticks, reproducible agent
              runs, and public scores remain planned.
            </p>
          </article>
        </div>
        <p className={styles.methodFoot}>
          The next layer is the planned{" "}
          <Link href="/roadmap#agent-league">OpenZaps Agent League</Link>. Ranked competition does not activate
          until every participant receives identical data, execution assumptions, and risk limits.
        </p>
      </section>
    </main>
  );
}
