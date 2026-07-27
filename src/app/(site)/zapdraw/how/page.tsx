import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { Walkthrough } from "./Walkthrough";
import styles from "./how.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.zapdrawHow,
  keywords: [
    "how ZapDraw works",
    "commit reveal game explained",
    "sealed bid game walkthrough",
    "0xZAPS game rules",
  ],
});

export default function HowPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.zapdrawHow),
            breadcrumbJsonLd("/zapdraw/how", "How a round plays out"),
          ],
        }}
      />

      <header className={`container ${styles.hero}`}>
        <p className={styles.eyebrow}>ZapDraw · one round, start to finish</p>
        <h1 className={styles.title}>Watch a round.</h1>
        <p className={styles.lead}>Scroll it. Real numbers, no reading required.</p>
      </header>

      <section className={`container ${styles.rule}`}>
        <p className={styles.ruleLine}>
          The bus pays a claim <strong>in full, or not at all.</strong> A claim it cannot cover
          completely is paid nothing — and the money it could not cover stays on the bus.
        </p>
      </section>

      <Walkthrough />

      <section className={`container ${styles.foot}`}>
        <h2 className={styles.footTitle}>That is the whole game.</h2>
        <p className={styles.footBody}>
          Claim a small slice and you are almost certainly paid it. Claim a big one and you are paid a lot —
          but only if enough of the table left room for you. Everyone chooses in secret, at the same time, and
          nothing but the other players decides how it lands.
        </p>
        <p className={styles.footBody}>
          The numbers above are not illustrations. They are computed by the same code that previews a live
          round, which mirrors what the contract does at settlement.
        </p>
        <p className={styles.footBody}>
          <Link href="/zapdraw" className={styles.footLink}>
            Go to the table &rarr;
          </Link>
        </p>
      </section>
    </main>
  );
}
