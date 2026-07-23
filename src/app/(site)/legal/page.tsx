import { TOKEN } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Risk disclosures",
  description:
    "The OpenZaps contracts have not been externally audited. Onchain actions are irreversible. 0xZAPS is an ERC-20 with no claim on revenue, yield, or assets. Read the relayer, market, and user-responsibility disclosures before signing anything.",
  path: "/legal",
  ogImage: "/og/legal.png",
  keywords: ["OpenZaps risk disclosures", "0xZAPS token risk"],
});

const risks = [
  ["No external audit", "The contracts and the interface have not been externally audited. They should not be treated as production-cleared for real funds. Depositing funds can result in total loss."],
  ["Onchain irreversibility", "Transactions, approvals, swaps, and deposits cannot be reversed by OpenZaps once submitted onchain. Once it executes, it cannot be undone."],
  ["Relayer risk", "A relayer may fail, censor, delay, or submit at an unfavorable time inside the signed constraints."],
  ["Market risk", "Slippage, liquidity, oracle movement, MEV, token volatility, and gas spikes can cause losses."],
  ["Token risk", `${TOKEN.symbol} is an ERC-20. It does not represent equity, revenue, yield, a redemption right, or a guarantee of protocol access. No return is implied.`],
  ["User responsibility", "Users must review wallet prompts, policy fields, amounts and spend limits, recipients, fees, and revocation paths before signing."],
] as const;

export default function LegalPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/legal", "Risk disclosures") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Risk disclosures</span>
          <h1>Bounded does not mean risk-free.</h1>
          <p>
            OpenZaps narrows what an agent can do. It does not remove smart-contract, wallet, relayer, market, token,
            legal, or operational risk.
          </p>
        </div>
        <aside className={styles.heroCard}>
          <span>Transaction posture</span>
          <strong>Wallet-confirmed broadcasts only</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Primary risks</h2>
          <div className={styles.table}>
            {risks.map(([name, body], i) => (
              <Reveal className={styles.row} delay={i * 45} key={name}>
                <strong>{name}</strong>
                <p>{body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.callout}>
          <span>No financial advice</span>
          <strong>Nothing in OpenZaps is an offer, solicitation, investment recommendation, or guarantee.</strong>
          <p>
            The product is software for inspecting and constraining onchain execution. Users should get independent
            legal, tax, security, and financial advice before using any crypto protocol.
          </p>
        </section>
      </section>
    </main>
  );
}
