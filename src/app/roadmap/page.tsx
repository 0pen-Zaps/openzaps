import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Roadmap",
  description:
    "OpenZaps roadmap for policy templates, wallet creation, Hermes relayers, adapter governance, monitoring, SDK, audits, and production launch.",
  path: "/roadmap",
  ogImage: "/og/roadmap.png",
  keywords: ["OpenZaps roadmap", "DeFi agent roadmap"],
});

const phases = [
  [
    "Now",
    "Live Robinhood v1.1",
    "Wallet connection, live v4 quotes, deterministic clones, EIP-712 execution, receipts, owner recovery, the live activity dashboard, and 0xZAPS holder utilities in the app.",
  ],
  [
    "Next",
    "Broader bounded routes",
    "More policy templates, additional governed adapters, and Hermes-assisted submission within owner-signed caps.",
  ],
  [
    "Hardening",
    "External audit milestone",
    "Third-party audit, formal verification, testnet soak, adapter manifests, governance runbook, and incident drills — planned hardening, not a product gate.",
  ],
  [
    "Beta",
    "Hermes private execution",
    "Allowlisted submitters, private submission, monitoring receipts, alert delivery, and owner self-submit fallback.",
  ],
  [
    "Network",
    "Reusable policy market",
    "Policy template registry, agent reputation, eval results, SDK publishing, and pool.fans / CliqueClaw integrations.",
  ],
] as const;

const principles = [
  "ERC-20 first until callback and multi-asset accounting risks are reviewed.",
  "Protective zaps stay blocked until oracle, liquidity, and liquidation risk controls are externally reviewed.",
  "Every fee must be visible in the typed policy before signing.",
  "Every automation needs pause, revoke, audit, and self-submit fallback paths.",
] as const;

export default function RoadmapPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/roadmap", "Roadmap") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Roadmap</span>
          <h1>Ship the primitive without widening the trust boundary.</h1>
          <p>
            OpenZaps can become the wallet primitive for agent-native DeFi, but only if each release keeps execution
            authority explicit, inspectable, and revocable.
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
