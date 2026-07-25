import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { fetchPots } from "@/lib/pot-server";
import { PotLive, type PotPayload } from "./PotLive";
import styles from "./pot.module.css";

export const metadata = pageMetadata({
  title: "0xZAPS lottery pot",
  description:
    "Every automated zap run pays 1% of its output — 20% of that fee accrues here and converts to 0xZAPS. See the live prize, the tickets in the round, the conversions, and every prize paid out. Deposited funds are at risk.",
  path: "/pot",
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
    <main className={styles.page} id="main">
      <JsonLd data={breadcrumbJsonLd("/pot", "Lottery pot")} />

      <section className={`container ${styles.hero}`}>
        <p className="eyebrow">Protocol fee · 0xZAPS</p>
        <h1>The fee buys the token.</h1>
        <p className={styles.lede}>
          Every automated run pays 1% of its output. Eighty percent goes to the executor that
          submitted it; the other twenty accrues here, becomes 0xZAPS, and is credited to the zap
          owners whose runs paid for it. Nothing about that is a projection — it is the pot&apos;s
          own balance, its own events, and the addresses below.
        </p>
        <p className={styles.heroLinks}>
          <Link href="/zap?view=automate">Create an automated zap</Link> ·{" "}
          <Link href="/explore">See the runs that fed it</Link>
        </p>
      </section>

      <PotLive initial={initial} />
    </main>
  );
}
