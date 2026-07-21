import { TOKEN } from "@/lib/config";
import { pageMetadata } from "@/lib/seo";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Risk disclosures",
  description:
    "OpenZaps risk disclosures for pre-audit contracts, onchain execution, token utility, relayer behavior, and user responsibility.",
  path: "/legal",
  keywords: ["OpenZaps risk disclosures", "0xZAPS token risk"],
});

const risks = [
  ["Pre-audit software", "The contracts and interface are not externally audited and should not be treated as production-cleared for real funds."],
  ["Onchain irreversibility", "Transactions, approvals, swaps, and deposits cannot be reversed by OpenZaps once submitted onchain."],
  ["Relayer risk", "A relayer may fail, censor, delay, or submit at an unfavorable time inside the signed constraints."],
  ["Market risk", "Slippage, liquidity, oracle movement, MEV, token volatility, and gas spikes can cause losses."],
  ["Token risk", `${TOKEN.symbol} does not represent equity, revenue, yield, a redemption right, or a guarantee of protocol access.`],
  ["User responsibility", "Users must review wallet prompts, policy fields, spend limits, recipients, fees, and revocation paths before signing."],
] as const;

export default function LegalPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
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
          <strong>No broadcast from preview UI</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Primary risks</h2>
          <div className={styles.table}>
            {risks.map(([name, body]) => (
              <div className={styles.row} key={name}>
                <strong>{name}</strong>
                <p>{body}</p>
              </div>
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
