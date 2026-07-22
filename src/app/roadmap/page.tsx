import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Roadmap",
  description:
    "What OpenZaps runs today, what is being worked on, and what is not decided. This page gives no dates. One bounded aeWETH ↔ 0xZAPS route is live; nothing beyond it is committed.",
  path: "/roadmap",
  ogImage: "/og/roadmap.png",
  keywords: ["OpenZaps roadmap", "DeFi agent roadmap"],
});

const phases = [
  [
    "Now",
    "Live v1.1 on Robinhood Chain",
    "Wallet connection, live v4 quotes, deterministic clones, EIP-712 execution, receipts, owner recovery, the activity dashboard, the visual builder, per-capsule onchain pages, and 0xZAPS holder utilities in the app. One route is deployable: a single-step aeWETH ↔ 0xZAPS swap. Everything else in the builder saves as a design.",
  ],
  [
    "Next",
    "More bounded routes",
    "More policy templates and additional governed adapters. Each adapter and token needs its own review and fork coverage before it can carry funds, so none of them is committed.",
  ],
  [
    "Hardening",
    "External audit",
    "No external audit, formal verification, testnet soak, adapter manifest, governance runbook, or incident drill has been completed. There is no date for any of them.",
  ],
  [
    "Beta",
    "Assisted submission",
    "Allowlisted submitters, private submission, receipt monitoring, and alert delivery, with an owner self-submit fallback. None of it is built. Today the owner submits every transaction from their own wallet.",
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
  "Every fee is visible in the typed policy before it is signed.",
  "Every automation keeps pause, revoke, audit, and self-submit fallback paths.",
] as const;

export default function RoadmapPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/roadmap", "Roadmap") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Roadmap</span>
          <h1>What is built, what is next, and what is not decided.</h1>
          <p>
            This page carries no dates. The order below is not a commitment: anything past the current release can be
            reordered or dropped. The constraint that does not move is that each release has to keep execution authority
            explicit, inspectable, and revocable.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/docs">
              Read docs
            </Link>
            <Link className="btn btnGhost btnLg" href="/security">
              Security gates
            </Link>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>Current release</span>
          <strong>Live v1.1 console</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Release path</h2>
          <div className={styles.timeline}>
            {phases.map(([phase, title, body], i) => (
              <Reveal className={styles.phase} delay={i * 45} key={phase}>
                <span>{phase}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2>Non-negotiables</h2>
          <ul>
            {principles.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}
