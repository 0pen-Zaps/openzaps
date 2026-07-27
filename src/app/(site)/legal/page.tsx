import { TOKEN } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.legal,
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
    <main className={styles.reader} id="main" data-screen-label="Risk disclosures">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [webPageJsonLd(STATIC_PAGE_SEO.legal), breadcrumbJsonLd("/legal", "Risk disclosures")],
        }}
      />

      <h1 className={styles.title}>Security risks and 0xZAPS token disclosures.</h1>
      <p className={styles.lede}>
        OpenZaps narrows what an agent can do. It does not remove smart-contract, wallet, relayer, market, token,
        legal, or operational risk.
      </p>
      <div className={styles.actions}>
        <span className={styles.metaChip}>
          <b>Transaction posture</b>
          Wallet-confirmed broadcasts only
        </span>
      </div>

      <section className={styles.section}>
        <h2 className={styles.h2}>Primary risks</h2>
        <div className={styles.defs}>
          {risks.map(([name, body], i) => (
            <Reveal className={styles.def} delay={i * 45} key={name}>
              <strong className={styles.defTerm}>{name}</strong>
              <p className={styles.defBody}>{body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={styles.note}>
        <span className={styles.noteEyebrow}>No financial advice</span>
        <strong className={styles.noteTitle}>
          Nothing in OpenZaps is an offer, solicitation, investment recommendation, or guarantee.
        </strong>
        <p className={styles.noteCopy}>
          The product is software for inspecting and constraining onchain execution. Users should get independent
          legal, tax, security, and financial advice before using any crypto protocol.
        </p>
      </section>
    </main>
  );
}
