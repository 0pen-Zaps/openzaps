import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.roadmap,
  keywords: ["OpenZaps roadmap", "DeFi agent roadmap"],
});

const phases = [
  [
    "Live",
    "Bounded execution on Robinhood Chain",
    "v1.1 and v3.1 enforce fixed one- to sixteen-step routes, recipients, assets, spend amounts, output floors, execution gas, gas price, cadence or price triggers, and executor access. Swaps, stitched routes, aeWETH/USDG liquidity, recurring series, and price-triggered Zaps are available in the builder.",
  ],
  [
    "Shipped",
    "Receipts, Guardian, policies, and public evidence",
    "The operations layer persists signed intents, execution receipts, cursor-safe relay state, executor scorecards, and read-only Guardian checks. Exact policy compilation, natural-language composition, signed and forkable public templates, the source-ready Agent Kit, and the public eval surface preserve the same rule: agents can discover and submit, but they cannot widen authority.",
  ],
  [
    "Release-ready",
    "Recurring Robinhood v3.2 stack",
    "The v3.2 contracts, deployment script, application path, fork coverage, independent readback checklist, and runtime adapter-bytecode manifest are complete. It is not live until the governance wallet broadcasts the reviewed deployment and the addresses pass the post-broadcast checks.",
  ],
  [
    "Gated",
    "Credentialed production launches",
    "Across funding, exact simulation, Guardian, wallet-bound template subscriptions, notifications, executor signing, and npm distribution remain off until their documented credentials, migrations, durable quotas, and operator checks exist. Private-relay fanout is implemented fail-closed for price-sensitive execution, but Robinhood Chain does not currently document enough independent private endpoints to activate that lane honestly.",
  ],
  [
    "Deferred",
    "Protective auto-deleverage",
    "Automated deleveraging is a separate protocol model, not another adapter. It stays out of this release because liabilities, oracle failure, venue liquidity, liquidation ordering, and bounded recovery need an explicit v1.x design before an agent can safely trigger it.",
  ],
] as const;

const principles = [
  "ERC-20 first. Callback tokens and multi-asset accounting stay out until their failure modes are reviewed.",
  "A registry allowlist is not bytecode identity: the reference signing executor independently pins and re-checks every adapter runtime hash.",
  "Every execution fee is bound by the typed intent or fixed in the capsule and disclosed before signing; every creation fee is shown with its conversion floor.",
  "Price-sensitive execution fails closed when its qualifying private-relay set is unavailable, records each dispatch result, and never silently falls back to a public endpoint.",
  "Every automation keeps nonce invalidation, emergency asset recovery, durable receipts, and an inspectable authority boundary.",
] as const;

export default function RoadmapPage(): React.JSX.Element {
  return (
    <main className={styles.reader} id="main" data-screen-label="Roadmap">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.roadmap), breadcrumbJsonLd("/roadmap", "Roadmap")],
        }}
      />

      <h1 className={styles.title}>What is built, what is next, and what is not decided.</h1>
      <p className={styles.lede}>
        This page carries no dates. The order below is not a commitment: anything past the current release can be
        reordered or dropped. The constraint that does not move is that each release has to keep execution authority
        explicit, inspectable, and recoverable.
      </p>
      <div className={styles.actions}>
        <Link className={styles.primaryBtn} href="/docs">
          Read docs
        </Link>
        <Link className={styles.ghostBtn} href="/evals">
          View evals
        </Link>
        <span className={styles.metaChip}>
          <b>Current release</b>
          Live v1.1 + v3.1
        </span>
      </div>

      <section className={styles.section}>
        <h2 className={styles.h2}>Release path</h2>
        <div className={styles.steps}>
          {phases.map(([phase, title, body], i) => (
            <Reveal className={`${styles.step} ${styles.stepPhased}`} delay={i * 45} key={phase}>
              <span className={styles.stepTag}>{phase}</span>
              <div>
                <h3 className={styles.stepTitle}>{title}</h3>
                <p className={styles.stepBody}>{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Non-negotiables</h2>
        <ul className={styles.list}>
          {principles.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
