import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { fetchPots } from "@/lib/pot-server";
import { PotLive, type PotPayload } from "./PotLive";
import styles from "./pot.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.pot,
  keywords: ["0xZAPS fee pot", "OpenZaps automation fee", "Robinhood Chain lottery pot"],
});

export const dynamic = "force-dynamic";

export default async function PotPage(): Promise<React.JSX.Element> {
  // Server-render the first snapshot so the page has real numbers before hydration;
  // a failed read hands the client a null and it shows an honest unavailable state
  // rather than a zeroed pot.
  let initial: PotPayload | null = null;
  try {
    initial = await fetchPots(null);
  } catch {
    initial = null;
  }

  return (
    <main className={styles.screen} id="main" data-screen-label="Pot">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.pot), breadcrumbJsonLd("/pot", "Lottery pot")],
        }}
      />

      <div className={styles.grid}>
        <div className={styles.col}>
          <span className={styles.eyebrow}>PROTOCOL FEE · 0xZAPS</span>
          <h1 className={styles.title}>The contribution buys the token.</h1>
          <p className={styles.lede}>
            Every automated Zap pays 1% of its output. Eighty percent goes to the executor that
            submitted it; the other twenty accrues here, becomes 0xZAPS once anyone converts it, and
            credits tickets in the current round to the owner of the Zap that paid it. A v3.2 recurring-stack
            run adds its separately signed stack slice to the same loop. None of that is a projection — it is
            each configured pot&apos;s own balance, ticket counters, and address below.
          </p>
          <p className={styles.heroLinks}>
            <Link href="/zap?view=automate">Create an automated Zap</Link> ·{" "}
            <Link href="/explore">See the Zaps that fed it</Link>
          </p>

          <PotLive initial={initial} />
        </div>

        {/* Rendered here rather than inside PotLive on purpose: both cards are
            statements about the protocol, not readings of it, so they must stay
            on screen while the pot reads are loading, stale, or unavailable. */}
        <aside className={styles.rail}>
          <section className={styles.splitCard}>
            <span className={styles.splitLabel}>THE SPLIT</span>
            <div className={styles.splitRow}>
              <strong className={styles.splitPct}>1%</strong>
              <span className={styles.splitOf}>of each automated Zap&apos;s output</span>
            </div>
            {/* The legend below states both numbers, so the bar is decoration. */}
            <div className={styles.splitBar} aria-hidden="true">
              <i className={styles.splitBarMajor} />
              <i className={styles.splitBarMinor} />
            </div>
            <div className={styles.splitLegend}>
              <span>80% executor</span>
              <span>20% pot</span>
            </div>
          </section>

          <section className={styles.noteCard}>
            <h2 className={styles.noteTitle}>No owner drain</h2>
            <p className={styles.noteBody}>
              Winner selection is governance-gated and the pot has no owner drain path. The token
              confers no yield, equity, revenue claim, governance, or protocol access.
            </p>
            <Link className={styles.noteLink} href="/zap?view=automate">
              Create an automated Zap →
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
