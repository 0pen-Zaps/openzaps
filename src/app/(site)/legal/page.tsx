import { TOKEN } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.legal,
  keywords: ["OpenZaps risk disclosures", "0xZAPS token risk", "ZapPad fee-share risk", "Robinhood Chain launch risk"],
});

const risks = [
  ["No external audit", "The contracts and the interface have not been externally audited. They should not be treated as production-cleared for real funds. Depositing funds can result in total loss."],
  ["Onchain irreversibility", "Transactions, approvals, swaps, and deposits cannot be reversed by OpenZaps once they are submitted onchain. Once an execution lands, nothing here can undo it."],
  ["Relayer and executor risk", "A relayer, or any executor eligible to submit a recurring or triggered Zap, may fail, censor, delay, or submit at an unfavorable time inside the signed constraints. If no executor serves an intent, nothing runs. Each automated run also pays a fixed 1% of its measured output as a protocol fee."],
  ["Market risk", "Slippage, liquidity, oracle movement, MEV, token volatility, and gas spikes can cause losses."],
  ["Token risk", `${TOKEN.symbol} is an ERC-20. It does not represent equity, revenue, yield, a redemption right, or a guarantee of protocol access. No return is implied.`],
  ["ZapPad fee-share risk", "A ZapPad fee-share ERC-20 concerns LP fees collected and checkpointed by one locked launch vault only. It is not 0xZAPS, OpenZaps equity or protocol-wide revenue, guaranteed yield, or a promise of returns."],
  ["ZapPad launch risk", "ZapPad is source-ready and not deployed. If activated after its release gates, token launches would still face unaudited-contract, liquidity, MEV, checkpoint-timing, external-dependency, key, accounting-dust, and total-loss risk."],
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

      <h1 className={styles.title}>Security, 0xZAPS, and ZapPad fee-share disclosures.</h1>
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

      <section className={styles.section}>
        <h2 className={styles.h2}>ZapPad economic and affiliation boundary</h2>
        <p className={styles.prose}>
          ZapPad is the source-ready token-launch feature inside OpenZaps. There is no approved mainnet launcher
          address, and its server-side write gate must remain disabled until a new exact-SHA deployment completes
          security review or documented low-value canary risk acceptance, specialist counsel review, source and
          receipt verification, a finalized WETH/USDG canary, and hosting controls.
        </p>
        <p className={styles.prose}>
          If deployed, each launch vault would permanently hold one Uniswap v3 LP NFT and issue one transferable
          fee-share ERC-20 with 100 whole shares, initially 80 to the creator and 20 to the reviewed protocol Safe.
          That split describes ownership of
          the vault&apos;s collected LP fees. It does not promise trading volume, fee accrual, harvesting, asset value,
          liquidity, redemption, or returns. Holding 0xZAPS does not confer ZapPad fee shares, and holding ZapPad fee
          shares confers no right in 0xZAPS or OpenZaps.
        </p>
        <p className={styles.prose}>
          OpenZaps and ZapPad are independent software and are not affiliated with, endorsed by, sponsored by, or
          operated by Robinhood Markets, Inc. or its affiliates. “Robinhood Chain” identifies the network only. The
          initial feature excludes Robinhood Stock Token pairs and must not present a permissionless launch as
          official equity, debt, a brokerage listing, a guaranteed return, or an official Robinhood product.
        </p>
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
