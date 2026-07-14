import type { Metadata } from "next";
import Link from "next/link";
import styles from "../docs/docs.module.css";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "OpenZaps roadmap for policy templates, wallet creation, Hermes relayers, adapter governance, monitoring, SDK, audits, and production launch.",
  alternates: { canonical: "/roadmap" },
};

const phases = [
  [
    "Now",
    "Review console",
    "Template builder, deterministic policy hashes, simulation checks, local audit log, dry-run receipts, and revoke controls.",
  ],
  [
    "Next",
    "Wallet-reviewed creation",
    "Connect wallet, prepare EIP-712 typed data, show exact approvals, and generate factory transactions without automatic broadcast.",
  ],
  [
    "Audit",
    "External security gates",
    "Third-party audit, formal verification, testnet soak, adapter manifests, governance runbook, and incident drills.",
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
          <strong>Review console</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Release path</h2>
          <div className={styles.timeline}>
            {phases.map(([phase, title, body]) => (
              <article className={styles.phase} key={phase}>
                <span>{phase}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </article>
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
