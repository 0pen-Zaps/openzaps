import type { Metadata } from "next";
import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { BuyButton } from "@/components/BuyButton";
import { TOKEN, TOKEN_LAUNCH, LINKS } from "@/lib/config";
import styles from "./token.module.css";

export const metadata: Metadata = {
  title: `${TOKEN.symbol} token`,
  description: `${TOKEN.symbol} is live on ${TOKEN_LAUNCH.venue} on ${TOKEN_LAUNCH.network}. Verify the official contract and trade link for the OpenZaps community token.`,
  alternates: { canonical: "/token" },
};

const facts = [
  { k: "Ticker", v: TOKEN.symbol },
  { k: "Token network", v: TOKEN_LAUNCH.network },
  { k: "Venue", v: TOKEN_LAUNCH.venue },
  { k: "Status", v: TOKEN_LAUNCH.status },
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
    title: "Align the operators",
    body: "Hermes runs, simulates, and monitors zaps. The token aligns the people who keep that execution layer honest and live.",
  },
  {
    title: "Public market identity",
    body: `The creator-verified ${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version} page and the onchain contract are the canonical token references.`,
  },
  {
    title: "A signal, not a promise",
    body: "0xZAPS is a community + coordination token. No yield, no TVL, no returns are implied — utility grows with the protocol.",
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
    a: "No. The protocol is permissionless. The token aligns the community and the execution layer around it.",
  },
  {
    q: "Are the contracts audited?",
    a: "The OpenZap protocol contracts are a complete, internally-audited reference implementation (47 passing tests, 9 findings fixed) but are pre-external-audit. Treat anything onchain accordingly.",
  },
] as const;

export default function TokenPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
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
          The community token for OpenZaps — immutable policy capsules for agent-triggered DeFi. Now live on{" "}
          <strong>{TOKEN_LAUNCH.network}</strong> through Clanker.
        </p>
        <div className={styles.heroActions}>
          <BuyButton size="lg" />
          <a className="btn btnGhost btnLg" href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
            View contract ↗
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
          <a className={styles.addressValue} href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
            {TOKEN_LAUNCH.contract} ↗
          </a>
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
            Not financial advice. {TOKEN.symbol} is a community token with no claim on revenue, yield, or assets.
            Onchain actions are irreversible; the protocol is pre-external-audit.
          </p>
        </div>
      </section>
    </main>
  );
}
