import type { Metadata } from "next";
import Link from "next/link";
import { TOKEN } from "@/lib/config";
import styles from "../docs/docs.module.css";

export const metadata: Metadata = {
  title: "Pricing and protocol fees",
  description:
    "OpenZaps pricing model for simulation, policy creation, relayer execution, protocol fees, and enterprise agent operations.",
  alternates: { canonical: "/pricing" },
};

const feeRows = [
  ["Simulation", "Free", "Local and API simulation should stay free so users can inspect policies before wallet review."],
  ["Policy creation", "Gas only during gated beta", "Users pay chain gas. No protocol fee until external audit and governance activation."],
  ["Hermes execution", "Relayer fee cap", "Every policy binds a max relayer fee before signing; Hermes cannot charge outside the cap."],
  ["Protocol fee", "Governance-disabled v1", "A future fee may apply to successful executions, but only after disclosure and wallet-level review."],
  ["Enterprise operators", "Custom", "Dedicated relayer lanes, compliance logs, policy review, and monitored revoke drills."],
] as const;

const tiers = [
  {
    name: "Builder",
    price: "Free",
    body: "Design templates, simulate policies, inspect hashes, export JSON, and test the review flow.",
  },
  {
    name: "Operator",
    price: "Relayer fee cap",
    body: "Run monitored policies through Hermes with bounded submitters, private submission, alerts, and audit logs.",
  },
  {
    name: "Protocol",
    price: "Governance-set",
    body: "Adapter governance, custom postconditions, dedicated monitoring, risk review, and launch-pool integrations.",
  },
] as const;

export default function PricingPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Pricing</span>
          <h1>Fees must be as bounded as the policies.</h1>
          <p>
            OpenZaps should never hide execution economics. Users see gas, relayer fee caps, protocol-fee status,
            revocation paths, and token disclosures before they sign.
          </p>
          <div className={styles.heroActions}>
            <Link className="btn btnPrimary btnLg" href="/app">
              Simulate a policy
            </Link>
            <Link className="btn btnGhost btnLg" href="/token">
              {TOKEN.symbol} tokenomics
            </Link>
          </div>
        </div>
        <aside className={styles.heroCard}>
          <span>v1 protocol fee</span>
          <strong>Disabled until audit</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Commercial model</h2>
          <p>
            The clean v1 is not a hidden spread business. The user signs the max relayer fee, the app shows expected gas,
            and any future protocol fee must be visible in the same typed policy payload.
          </p>
          <div className={styles.table}>
            {feeRows.map(([name, price, body]) => (
              <div className={styles.row} key={name}>
                <strong>
                  {name}
                  <br />
                  <span>{price}</span>
                </strong>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2>Access tiers</h2>
          <div className={styles.twoCol}>
            {tiers.map((tier) => (
              <article key={tier.name}>
                <h3>{tier.name}</h3>
                <p>
                  <strong>{tier.price}</strong>
                </p>
                <p>{tier.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.callout}>
          <span>Token disclosure</span>
          <strong>{TOKEN.symbol} is not a fee claim, yield promise, equity claim, or guarantee of access.</strong>
          <p>
            Token utility should grow through governance, operator alignment, and ecosystem coordination, but the product
            must remain usable and reviewable without implying financial returns.
          </p>
        </section>
      </section>
    </main>
  );
}
