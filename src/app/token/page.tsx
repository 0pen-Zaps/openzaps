import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BuyButton } from "@/components/BuyButton";
import { JsonLd } from "@/components/JsonLd";
import { TokenUtilities } from "@/components/TokenUtilities";
import { TOKEN, TOKEN_LAUNCH, LINKS } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL } from "@/lib/seo";
import { Reveal } from "@/components/Reveal";
import { CopyButton } from "@/components/CopyButton";
import styles from "./token.module.css";

export const metadata = pageMetadata({
  title: `${TOKEN.symbol} token — live on ${TOKEN_LAUNCH.network}`,
  description: `${TOKEN.symbol} is live on ${TOKEN_LAUNCH.network} through ${TOKEN_LAUNCH.venue}. Verify the contract, add it to your wallet, or open the bounded aeWETH/0xZAPS route.`,
  path: "/token",
  ogImage: "/og/token.png",
  keywords: [
    `buy ${TOKEN.symbol}`,
    `${TOKEN.symbol} ${TOKEN_LAUNCH.venue}`,
    `${TOKEN.symbol} ${TOKEN_LAUNCH.network}`,
    `${TOKEN.symbol} contract address`,
    "how to buy 0xZAPS",
  ],
});

const facts = [
  { k: "Ticker", v: TOKEN.symbol },
  { k: "Token network", v: TOKEN_LAUNCH.network },
  { k: "Venue", v: TOKEN_LAUNCH.venue },
  { k: "Decimals", v: String(TOKEN.decimals) },
] as const;

const steps = [
  {
    n: "01",
    title: "Open the official Clanker market",
    body: `Use the market linked from this site and confirm it shows ${TOKEN.name} (${TOKEN.symbol}).`,
  },
  {
    n: "02",
    title: "Verify the contract",
    body: `Match the token contract exactly: ${TOKEN_LAUNCH.contract}. Do not trade a lookalike ticker.`,
  },
  {
    n: "03",
    title: `Trade ${TOKEN.symbol}`,
    body: `Connect through Clanker's supported wallet flow, review the ${TOKEN_LAUNCH.network} transaction, and confirm it in your wallet.`,
  },
] as const;

const utility = [
  {
    title: "A bounded route asset",
    body: "The live OpenZaps v1.1 adapter supports one pinned Robinhood v4 pool: aeWETH ↔ 0xZAPS. The app builds immutable one-route policy capsules around it.",
  },
  {
    title: "Holder utilities, live in the app",
    body: "Hold 100,000+ 0xZAPS in your connected wallet and the app console unlocks auto-refreshing live quotes, extended zap history (50 slots; 100 at 1,000,000+), longer receipt retention, and one-click receipt JSON export. App-level conveniences, checked against your live balance — not protocol rights.",
  },
  {
    title: "Wallet-readable ERC-20",
    body: `Use the exact ${TOKEN_LAUNCH.network} address, ${TOKEN.decimals} decimals, and the add-to-wallet utility on this page. Wallet support varies.`,
  },
  {
    title: "No invented rights",
    body: "The token does not grant protocol governance, staking, revenue, yield, equity, or fee rights. Every core OpenZaps workflow — create, fund, execute, recover — works without holding it.",
  },
] as const;

const faqs = [
  {
    q: `Where does ${TOKEN.symbol} live?`,
    a: `${TOKEN.symbol} is live on ${TOKEN_LAUNCH.network} through Clanker. Its contract is ${TOKEN_LAUNCH.contract}.`,
  },
  {
    q: `Where can I buy ${TOKEN.symbol}?`,
    a: `Use the official Clanker market linked on this page and verify ${TOKEN_LAUNCH.contract} before signing.`,
  },
  {
    q: "Do I need the token to use OpenZaps?",
    a: "No. Every core workflow — create, fund, execute, recover — works without it. Holding 100,000+ 0xZAPS unlocks optional app conveniences: auto-refreshing quotes, extended zap and receipt history, and receipt JSON export.",
  },
  {
    q: "Are the contracts audited?",
    a: "No external audit is published for the OpenZap v1.1 protocol contracts. The app labels the live workflow pre-external-audit; deposited funds are at risk.",
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
        <span className="badge">Live on {TOKEN_LAUNCH.network}</span>
        <div className={styles.heroMark}>
          <OpenZapMark />
        </div>
        <h1 className={styles.title}>
          <span className="gradientText">{TOKEN.symbol}</span>
        </h1>
        <p className={styles.lead}>
          The ERC-20 paired with aeWETH in OpenZaps&apos; first bounded live route. Verify the exact contract on{" "}
          <strong>{TOKEN_LAUNCH.network}</strong> before trading or adding it to a wallet.
        </p>
        <div className={styles.heroActions}>
          <BuyButton size="lg" />
          <a className="btn btnGhost btnLg" href={LINKS.dexscreener} target="_blank" rel="noreferrer">
            Dexscreener ↗
          </a>
          <a className="btn btnGhost btnLg" href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
            View contract ↗
          </a>
        </div>

        <div className={styles.facts}>
          {facts.map((f, i) => (
            <Reveal className={styles.fact} delay={i * 60} key={f.k}>
              <span>{f.k}</span>
              <strong>{f.v}</strong>
            </Reveal>
          ))}
        </div>
      </section>

      {/* contract address */}
      <section className={`container ${styles.addressWrap}`}>
        <div className={styles.address}>
          <div className={styles.addressIdentity}>
            <span className={styles.addressLabel}>{TOKEN.symbol} contract</span>
            <a className={styles.addressValue} href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
              {TOKEN_LAUNCH.contract} ↗
            </a>
            {/* The address is the highest-stakes string on the site — mistyping
                it loses funds. Copying it must never require a manual selection. */}
            <CopyButton
              className={styles.addressCopy}
              label="Copy address"
              title={`Copy the ${TOKEN.symbol} contract address`}
              value={TOKEN_LAUNCH.contract}
            />
          </div>
          <TokenUtilities />
        </div>
      </section>

      {/* how to buy */}
      <section className={`container ${styles.section}`}>
        <header className={styles.head}>
          <span className="eyebrow">How to buy</span>
          <h2>Three steps to {TOKEN.symbol}.</h2>
        </header>
        <div className={styles.steps}>
          {steps.map((s, i) => (
            <Reveal as="article" className={`${styles.step} spotlight`} delay={i * 90} key={s.n}>
              <span className={styles.stepNum}>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
        <div className={styles.buyRow}>
          <BuyButton size="lg" />
        </div>
      </section>

      {/* utility */}
      <section className={`container ${styles.section}`}>
        <header className={styles.head} id="utilities">
          <span className="eyebrow">What it&apos;s for</span>
          <h2>Only the utility that exists today.</h2>
          <p>
            Every utility below is implemented and live right now. No governance, staking, fee share, revenue claim,
            equity, yield, or returns are represented.
          </p>
        </header>
        <div className={styles.utilGrid}>
          {utility.map((u, i) => (
            <Reveal as="article" className={`${styles.utilCard} spotlight`} delay={i * 80} key={u.title}>
              <h3>{u.title}</h3>
              <p>{u.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* official launch references */}
      <section className={`container ${styles.section}`}>
        <div className={styles.dist}>
          <div className={styles.distCopy}>
            <span className="eyebrow">Verify before trading</span>
            <h2>One contract. One official market.</h2>
            <p>
              Tickers and screenshots can be copied. The Clanker market and {TOKEN_LAUNCH.network} contract below are
              the canonical references; live market data can change at any time.
            </p>
          </div>
          <div className={styles.verifyList}>
            <a className={styles.verifyRow} href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
              <span>Contract</span>
              <strong>{TOKEN_LAUNCH.contract}</strong>
              <i aria-hidden>↗</i>
            </a>
            <a className={styles.verifyRow} href={LINKS.clanker} target="_blank" rel="noreferrer">
              <span>Official market</span>
              <strong>{TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version}</strong>
              <i aria-hidden>↗</i>
            </a>
            <a className={styles.verifyRow} href={LINKS.dexscreener} target="_blank" rel="noreferrer">
              <span>Live chart</span>
              <strong>Dexscreener</strong>
              <i aria-hidden>↗</i>
            </a>
            <a className={styles.verifyRow} href={TOKEN_LAUNCH.explorer} target="_blank" rel="noreferrer">
              <span>Network</span>
              <strong>{TOKEN_LAUNCH.network}</strong>
              <i aria-hidden>↗</i>
            </a>
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
            Not financial advice. {TOKEN.symbol} is an ERC-20 with no claim on revenue, yield, or assets.
            Onchain actions are irreversible; the protocol is pre-external-audit.
          </p>
        </div>
      </section>
    </main>
  );
}
