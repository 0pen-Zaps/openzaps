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
  ["Onchain irreversibility", "Transactions, approvals, swaps, and deposits cannot be reversed by OpenZaps once they are submitted onchain. Once an execution lands, nothing here can undo it."],
  ["Relayer and executor risk", "A relayer, or any executor eligible to submit a recurring or triggered Zap, may fail, censor, delay, or submit at an unfavorable time inside the signed constraints. If no executor serves an intent, nothing runs. Each automated run also pays a fixed 1% of its measured output as a protocol fee."],
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
          Owner-signed intents only
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

      <section className={styles.section} id="request-data">
        <h2 className={styles.h2}>Request data and privacy</h2>
        <div className={styles.defs}>
          <div className={styles.def}>
            <strong className={styles.defTerm}>What the request desk stores</strong>
            <p className={styles.defBody}>
              A Request a Zap submission stores the name and email you provide,
              project details, workflow, protocols or assets, trigger, safety
              limits, timeline, consent record, minimized campaign labels, and
              only the referring website&apos;s origin. OpenZaps derives a
              non-reversible abuse-control value from the request network
              address, but keeps it separately from lead records and never
              stores the raw address.
            </p>
          </div>
          <div className={styles.def}>
            <strong className={styles.defTerm}>Why it is used</strong>
            <p className={styles.defBody}>
              Authorized operators use this data only to assess the requested
              workflow, prevent form abuse, and reply about that request.
              A server-only email delivery provider forwards the submitted
              details to the designated OpenZaps operator mailbox so new
              requests can be reviewed promptly. That notification copy is
              separately processed and retained under the email delivery
              provider&apos;s and operator mailbox&apos;s policies; the database
              expiry below does not automatically delete an already-delivered
              email. Submission does not join a newsletter, authorize
              automated outreach, or grant any wallet or signing authority.
            </p>
          </div>
          <div className={styles.def}>
            <strong className={styles.defTerm}>How long it remains</strong>
            <p className={styles.defBody}>
              Request-desk database records expire after 180 days. A
              human-reviewed active design conversation may be renewed only
              within a fixed one-year maximum, and a closed request expires
              within 30 days. A daily retention job removes expired database
              records and short-lived abuse controls. Operators should delete
              the corresponding mailbox notification when its request is
              deleted; email-provider service records follow that
              provider&apos;s retention terms.
            </p>
          </div>
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
