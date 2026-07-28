import Link from "next/link";

import { Glyph } from "@/components/Glyph";
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
    <main className={styles.screen} id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.zapdrawHow),
            breadcrumbJsonLd("/zapdraw/how", "How a round plays out"),
          ],
        }}
      />

      <header className={styles.head}>
        <span className={styles.eyebrow}>ZapDraw · one round, start to finish</span>
        <h1 className={styles.title}>Watch a round.</h1>
        <p className={styles.lead}>Step by step, in real numbers. No reading required.</p>
      </header>

      <section className={styles.rule}>
        <Glyph name="alert" className={styles.ruleIcon} />
        <p className={styles.ruleLine}>
          Two rules do all the work. A sealed draw you never open is{" "}
          <strong>forfeited</strong> — the entry is gone and it funds everyone else. And the bus pays
          a draw it does open <strong>in full, or not at all:</strong> one it cannot cover completely
          is paid nothing, and the money it could not be paid from stays on the bus.
        </p>
      </section>

      <Walkthrough />

      <section className={styles.foot}>
        <h2 className={styles.footTitle}>That is the whole game.</h2>
        <p className={styles.footBody}>
          Draw a small slice and you are almost certainly paid it. Draw a big one and you are paid a lot —
          but only if enough of the table left room for you. Everyone chooses in secret, at the same time, and
          nothing but the other players decides how it lands.
        </p>
        <p className={styles.footBody}>
          The one outcome that is nobody else&rsquo;s doing is the seat above that never opened. Sealing costs
          the entry; opening is what turns it into a claim. Come back inside the reveal window and the worst
          the table can do to you is pay you nothing. Miss it, and you paid for the round anyway.
        </p>
        <p className={styles.footBody}>
          The numbers above are not illustrations. They are computed by the same code that previews a live
          round, which mirrors what the contract does at settlement.
        </p>
        <p>
          <Link href="/zapdraw" className={styles.footLink}>
            Go to the table &rarr;
          </Link>
        </p>
      </section>
    </main>
  );
}
