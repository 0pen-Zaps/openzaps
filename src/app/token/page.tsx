import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BuyButton } from "@/components/BuyButton";
import { JsonLd } from "@/components/JsonLd";
import { TOKEN, CHAIN, CONTRACTS, LINKS } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL } from "@/lib/seo";
import styles from "./token.module.css";

export const metadata = pageMetadata({
  title: `${TOKEN.symbol} token — fair launch on pool.fans`,
  description: `${TOKEN.symbol} is the token for OpenZaps, launching fair on the pool.fans tokenizer on ${CHAIN.name}. No presale, no team allocation — 100% of supply enters through the bonding curve.`,
  path: "/token",
  keywords: [
    `buy ${TOKEN.symbol}`,
    `${TOKEN.symbol} fair launch`,
    `${TOKEN.symbol} pool.fans`,
    `${TOKEN.symbol} ${CHAIN.name}`,
    "how to buy 0xZAPS",
    "0xZAPS contract address",
  ],
});

const facts = [
  { k: "Ticker", v: TOKEN.symbol },
  { k: "Network", v: CHAIN.name },
  { k: "Venue", v: "pool.fans tokenizer" },
  { k: "Model", v: "Fair launch" },
] as const;

const steps = [
  {
    n: "01",
    title: "Get a wallet on " + CHAIN.name,
    body: "Any EOA or Safe works. Fund it with a little ETH for gas — the same wallet can later sign OpenZap intents.",
  },
  {
    n: "02",
    title: "Open the pool.fans page",
    body: `Head to the ${TOKEN.symbol} page on the pool.fans tokenizer. The curve is open and permissionless — no allowlist, no presale.`,
  },
  {
    n: "03",
    title: `Swap into ${TOKEN.symbol}`,
    body: "Buy on the bonding curve. Your balance settles onchain instantly; come back and open the app to run zaps.",
  },
] as const;

const utility = [
  {
    title: "Align the operators",
    body: "Hermes runs, simulates, and monitors zaps. The token aligns the people who keep that execution layer honest and live.",
  },
  {
    title: "Curve + fee participation",
    body: "Launched on the pool.fans tokenizer, so value accrues through the bonding curve and fee mechanics of the launchpad itself.",
  },
  {
    title: "A signal, not a promise",
    body: "0xZAPS is a community + coordination token. No yield, no TVL, no returns are implied — utility grows with the protocol.",
  },
] as const;

const faqs = [
  {
    q: `Where does ${TOKEN.symbol} live?`,
    a: `On the pool.fans tokenizer on ${CHAIN.name}. Trading happens against its bonding curve; the contract address appears here once the launch transaction confirms.`,
  },
  {
    q: "Is there a presale or team allocation?",
    a: "No presale and no private allocation. It launches fair on the curve — everyone buys from the same place at the same time.",
  },
  {
    q: "Do I need the token to use OpenZaps?",
    a: "No. The protocol is permissionless. The token aligns the community and the execution layer around it.",
  },
  {
    q: "Are the contracts audited?",
    a: "The OpenZap protocol contracts are a complete, internally-audited reference implementation (47 passing tests, 9 findings fixed) but are pre-external-audit. Treat anything onchain accordingly.",
  },
] as const;

// Derived from the same `faqs` array that renders the visible FAQ, so the structured data
// can never drift from on-page copy (a Google FAQPage requirement).
const tokenPageJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "FAQPage",
      "@id": absoluteUrl("/token#faq"),
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
    {
      "@type": "BreadcrumbList",
      "@id": absoluteUrl("/token#breadcrumbs"),
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "OpenZaps", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: `${TOKEN.symbol} token`, item: absoluteUrl("/token") },
      ],
    },
  ],
};

export default function TokenPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={tokenPageJsonLd} />
      {/* hero */}
      <section className={`container ${styles.hero}`}>
        <span className="badge">⚡ Launching on pool.fans</span>
        <div className={styles.heroMark}>
          <OpenZapMark />
        </div>
        <h1 className={styles.title}>
          <span className="gradientText">{TOKEN.symbol}</span>
        </h1>
        <p className={styles.lead}>
          The token for OpenZaps — immutable intent lockers for agent-triggered DeFi. Fair launch on the{" "}
          <strong>pool.fans</strong> tokenizer, {CHAIN.name}.
        </p>
        <div className={styles.heroActions}>
          <BuyButton size="lg" />
          <a className="btn btnGhost btnLg" href={LINKS.poolfans} target="_blank" rel="noreferrer">
            pool.fans/openzaps ↗
          </a>
        </div>

        <div className={styles.facts}>
          {facts.map((f) => (
            <div className={styles.fact} key={f.k}>
              <span>{f.k}</span>
              <strong>{f.v}</strong>
            </div>
          ))}
        </div>
      </section>

      {/* contract address */}
      <section className={`container ${styles.addressWrap}`}>
        <div className={styles.address}>
          <span className={styles.addressLabel}>{TOKEN.symbol} contract</span>
          {CONTRACTS.token ? (
            <a
              className={styles.addressValue}
              href={`${CHAIN.explorer}/token/${CONTRACTS.token}`}
              target="_blank"
              rel="noreferrer"
            >
              {CONTRACTS.token} ↗
            </a>
          ) : (
            <span className={styles.addressPending}>Available the moment the launch tx confirms</span>
          )}
        </div>
      </section>

      {/* how to buy */}
      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">How to buy</span>
          <h2>Three steps to {TOKEN.symbol}.</h2>
        </header>
        <div className={styles.steps}>
          {steps.map((s) => (
            <article className={styles.step} key={s.n}>
              <span className={styles.stepNum}>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
        <div className={styles.buyRow}>
          <BuyButton size="lg" />
        </div>
      </section>

      {/* utility */}
      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">What it&apos;s for</span>
          <h2>One token, aligned with the protocol.</h2>
          <p>No yield, no TVL, no returns are implied. {TOKEN.symbol} is coordination, not a security.</p>
        </header>
        <div className={styles.utilGrid}>
          {utility.map((u) => (
            <article className={styles.utilCard} key={u.title}>
              <h3>{u.title}</h3>
              <p>{u.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* distribution */}
      <section className={`container ${styles.section}`}>
        <div className={styles.dist}>
          <div className={styles.distCopy}>
            <span className="eyebrow">Distribution</span>
            <h2>Fair launch. No games.</h2>
            <p>
              100% of supply enters through the pool.fans bonding curve. No presale, no team unlock schedule, no
              private rounds — the curve is the only door in.
            </p>
          </div>
          <div className={styles.distBars}>
            <div className={styles.distBar}>
              <div className={styles.distFill} style={{ width: "100%" }} />
              <span className={styles.distLabel}>Bonding curve · 100%</span>
            </div>
            <div className={styles.distBar}>
              <div className={`${styles.distFill} ${styles.distMuted}`} style={{ width: "0%" }} />
              <span className={styles.distLabel}>Presale · 0%</span>
            </div>
            <div className={styles.distBar}>
              <div className={`${styles.distFill} ${styles.distMuted}`} style={{ width: "0%" }} />
              <span className={styles.distLabel}>Team unlock · 0%</span>
            </div>
          </div>
        </div>
      </section>

      {/* faq */}
      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">FAQ</span>
          <h2>Good to know.</h2>
        </header>
        <div className={styles.faqs}>
          {faqs.map((f) => (
            <details className={styles.faq} key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* cta */}
      <section className={`container ${styles.cta}`}>
        <div className={styles.ctaInner}>
          <h2>
            Ready? Get <span className="gradientText">{TOKEN.symbol}</span>.
          </h2>
          <div className={styles.heroActions}>
            <BuyButton size="lg" />
            <Link className="btn btnGhost btnLg" href="/app">
              Open the app
            </Link>
          </div>
          <p className={styles.disclaimer}>
            Not financial advice. {TOKEN.symbol} is a community token with no claim on revenue, yield, or assets.
            Onchain actions are irreversible; the protocol is pre-external-audit.
          </p>
        </div>
      </section>
    </main>
  );
}
