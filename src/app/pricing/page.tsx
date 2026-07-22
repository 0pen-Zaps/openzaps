import Link from "next/link";
import { TOKEN } from "@/lib/config";
import { JsonLd } from "@/components/JsonLd";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import styles from "../docs/docs.module.css";

export const metadata = pageMetadata({
  title: "Pricing and protocol fees",
  description:
    "What OpenZaps charges today: chain gas, and nothing else. The v1 protocol fee is disabled, the live route sets the relayer fee cap to zero, and every fee has to be visible in the typed policy before it is signed.",
  path: "/pricing",
  ogImage: "/og/pricing.png",
  keywords: ["OpenZaps pricing", "protocol fees", "relayer fee cap"],
});

const feeRows = [
  ["Simulation", "Free", "Simulation runs locally and through the API. It never broadcasts a transaction and never asks for wallet authority."],
  ["Policy creation", "Gas only", "You pay chain gas to create and fund a capsule. No protocol fee is taken. The contracts have not been externally audited."],
  ["Relayer execution", "Cap of zero", "A policy binds a maximum relayer fee before it is signed, so a submitter cannot charge outside the cap. The live route sets that cap to zero, which means no execution of it can pay a relayer at all."],
  ["Protocol fee", "Disabled in v1", "No protocol fee is charged on any execution. A future fee would have to appear in the same typed policy payload the user signs."],
  ["Enterprise operators", "Not built", "Dedicated submission lanes, compliance logs, policy review, and revoke drills are on the roadmap. None of them exist yet, and none has a date."],
] as const;

const tiers = [
  {
    name: "Builder",
    price: "Free",
    body: "Design a chain, simulate a policy, read the compiled checks, and export JSON. No wallet is asked for anything, and nothing is broadcast.",
  },
  {
    name: "Operator",
    price: "Not live",
    body: "Assisted submission within owner-signed caps is planned. It does not exist. Today every transaction is submitted and confirmed from your own wallet.",
  },
  {
    name: "Protocol",
    price: "Not live",
    body: "Adapter governance, custom postconditions, and dedicated monitoring are planned. None of them is available today.",
  },
] as const;

export default function PricingPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/pricing", "Pricing and protocol fees") }} />
      <section className={`container ${styles.hero}`}>
        <div>
          <span className="eyebrow">Pricing</span>
          <h1>What you pay today is gas.</h1>
          <p>
            There is no protocol fee in v1. The live route sets the relayer fee cap to zero, so no execution of it can
            pay a submitter. You see the expected gas, the fee cap, the recipient, and the revocation path before the
            wallet is asked to sign anything.
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
          <strong>Disabled in v1</strong>
        </aside>
      </section>

      <section className={`container ${styles.content}`}>
        <section className={styles.section}>
          <h2>Commercial model</h2>
          <p>
            There is no spread. The user signs the maximum relayer fee, the app shows the expected gas, and any future
            protocol fee has to be visible in the same typed policy payload before that payload can be signed.
          </p>
          <div className={styles.table}>
            {feeRows.map(([name, price, body], i) => (
              <Reveal className={styles.row} delay={i * 45} key={name}>
                <strong>
                  {name}
                  <br />
                  <span>{price}</span>
                </strong>
                <p>{body}</p>
              </Reveal>
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
            {TOKEN.symbol} is an ERC-20 with no claim on revenue, yield, or assets. It is the asset paired with aeWETH
            in the one live route. Holding 100,000+ turns on app conveniences: auto-refreshing quotes, more saved zaps
            and receipts, and receipt JSON export. It grants no governance, staking, revenue share, or protocol rights.
            Every core workflow works without it.
          </p>
        </section>
      </section>
    </main>
  );
}
