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
    "Now",
    "Live v1.1 + v3.1 on Robinhood Chain",
    "Bounded swaps, stitched routes, aeWETH/USDG liquidity, recurring series, and price triggers are live. The visual builder composes typed route blocks with signed execution gas, gas-price, and executor-access policies; the three execution controls can be inserted as one undoable stack and carried into Zap now or Automate.",
  ],
  [
    "Next",
    "More bounded routes and policies",
    "More policy templates and governed adapters. Each new field, adapter, and token needs contract support, explicit disclosure, and fork coverage before it can carry funds, so none is committed.",
  ],
  [
    "Hardening",
    "External audit",
    "No external audit, formal verification, testnet soak, adapter manifest, governance runbook, or incident drill has been completed. There is no date for any of them.",
  ],
  [
    "Beta",
    "Private submission and monitoring",
    "Private submission, receipt monitoring, and alert delivery. None of that is built: the console lists the transactions you signed in it, and nothing watches a Zap for you or sends a notification. Permissionless executor submission is built: a recurring or triggered intent either pins one executor or leaves it open to anyone, signed intents publish to a shared relay executors poll, and the owner can always submit a run themselves.",
  ],
  [
    "Network",
    "Reusable policies",
    "A policy template registry, agent reputation, published eval results, and an SDK. This is the least decided part of the list, and we do not know how much of it is worth building.",
  ],
] as const;

const principles = [
  "ERC-20 first. Callback tokens and multi-asset accounting stay out until their failure modes are reviewed.",
  "Protective zaps stay blocked until oracle, liquidity, and liquidation risk controls are externally reviewed.",
  "Every execution fee is visible in the typed intent, and every creation fee is visible with its conversion floor before the wallet transaction is signed.",
  "Every automation keeps nonce invalidation, emergency asset recovery, auditability, and self-submit fallback paths.",
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
        <Link className={styles.ghostBtn} href="/docs#security">
          Security model
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
              {/* The neutral tag, not a live/done badge. Only the first phase
                  has shipped, and the copy says so — a coloured chip on the
                  other four would claim progress nothing has made. */}
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
