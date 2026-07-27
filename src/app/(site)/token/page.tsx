import Image from "next/image";
import Link from "next/link";

import { CopyButton } from "@/components/CopyButton";
import { Glyph } from "@/components/Glyph";
import { JsonLd } from "@/components/JsonLd";
import { TokenUtilities } from "@/components/TokenUtilities";
import { buyUrl, TOKEN, TOKEN_LAUNCH, LINKS } from "@/lib/config";
import {
  STATIC_PAGE_SEO,
  SITE_URL,
  absoluteUrl,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";
import styles from "./token.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.token,
  keywords: [
    `buy ${TOKEN.symbol}`,
    `${TOKEN.symbol} ${TOKEN_LAUNCH.venue}`,
    `${TOKEN.symbol} ${TOKEN_LAUNCH.network}`,
    `${TOKEN.symbol} contract address`,
    "how to buy 0xZAPS",
  ],
});

const steps = [
  {
    n: "01",
    title: "Choose a verified buy path",
    body: `Use OpenZaps' pinned aeWETH → ${TOKEN.symbol} route or the official Clanker market linked from this site.`,
  },
  {
    n: "02",
    title: "Verify the contract",
    body: `Match the token contract exactly: ${TOKEN_LAUNCH.contract}. A ticker and a logo cost nothing to copy, and anyone can deploy a lookalike. The address is the only thing that tells them apart.`,
  },
  {
    n: "03",
    title: "Review and sign in your wallet",
    body: `Check the exact input, quote, minimum output, destination, and every ${TOKEN_LAUNCH.network} transaction before confirming. OpenZaps shows its bounded policy before execution; Clanker uses its supported market flow.`,
  },
] as const;

const utility: readonly { title: string; body: string; danger?: boolean }[] = [
  {
    title: "The asset in the first live route",
    body: "The first live v1.1 adapter is bound to a single pinned Robinhood v4 pool: aeWETH ↔ 0xZAPS. It cannot route to another token, spender, hook, or DEX. A second pinned pool (aeWETH ↔ USDG) is live and does not involve 0xZAPS — each adapter is welded to exactly one pool.",
  },
  {
    title: "App conveniences at a balance threshold",
    body: "Hold 100,000+ 0xZAPS in the connected wallet and the app auto-refreshes live quotes, keeps 50 saved zaps instead of 20, retains 100 receipts instead of 20, and enables receipt JSON export. At 1,000,000+ the saved-zap limit is 100. The app reads the balance; the contracts never do.",
  },
  {
    title: "Wallet-readable ERC-20",
    body: `Use the exact ${TOKEN_LAUNCH.network} address, ${TOKEN.decimals} decimals, and the add-to-wallet utility on this page. Wallet support varies.`,
  },
  {
    title: "What it does not grant",
    body: "The token grants no protocol governance, staking, revenue, yield, equity, or fee rights. It is not equity and no return is implied. Every core workflow — create, fund, execute, recover — works without holding it.",
    danger: true,
  },
];

const verifyLinks = [
  { k: "Contract", v: TOKEN_LAUNCH.contract, href: LINKS.tokenExplorer },
  { k: "Official market", v: `${TOKEN_LAUNCH.venue} ${TOKEN_LAUNCH.version}`, href: LINKS.clanker },
  { k: "Live chart", v: "Dexscreener", href: LINKS.dexscreener },
  { k: "Network", v: TOKEN_LAUNCH.network, href: TOKEN_LAUNCH.explorer },
] as const;

const faqs = [
  {
    q: `Where does ${TOKEN.symbol} live?`,
    a: `${TOKEN.symbol} is live on ${TOKEN_LAUNCH.network} through Clanker. Its contract is ${TOKEN_LAUNCH.contract}.`,
  },
  {
    q: `Where can I buy ${TOKEN.symbol}?`,
    a: `Use OpenZaps' pinned aeWETH → ${TOKEN.symbol} route or the official Clanker market linked on this page. Verify ${TOKEN_LAUNCH.contract} before signing either path.`,
  },
  {
    q: "Do I need the token to use OpenZaps?",
    a: "No. Creating, funding, executing, and recovering a Zap all work without holding 0xZAPS. Holding 100,000+ 0xZAPS turns on app conveniences — auto-refreshing quotes, more saved zaps and receipts, and receipt JSON export — which the app checks against the connected wallet's balance. The contracts do not read it.",
  },
  {
    q: "Are the contracts audited?",
    a: "No external audit is published for the OpenZap v1.1 protocol contracts. Deposited funds are at risk. Onchain actions are irreversible.",
  },
] as const;

// Derived from the same `faqs` array that renders the visible FAQ, so the structured data
// can never drift from on-page copy (a Google FAQPage requirement).
const tokenPageJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    webPageJsonLd(STATIC_PAGE_SEO.token),
    {
      "@type": "Product",
      "@id": absoluteUrl("/token#token"),
      name: `${TOKEN.symbol} token`,
      image: absoluteUrl(TOKEN.logoPath),
      description: STATIC_PAGE_SEO.token.description,
      brand: { "@id": `${SITE_URL}/#organization` },
      sku: TOKEN_LAUNCH.contract,
      category: "ERC-20 token",
      sameAs: [TOKEN_LAUNCH.contractUrl, TOKEN_LAUNCH.tradeUrl, TOKEN_LAUNCH.dexscreenerUrl],
      mainEntityOfPage: { "@id": absoluteUrl("/token#webpage") },
    },
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
    <main className={styles.screen} id="main" data-screen-label={TOKEN.symbol}>
      <JsonLd data={tokenPageJsonLd} />

      <div className={styles.top}>
        <div className={styles.col}>
          <h1 className={`${styles.title} gradientText`}>{TOKEN.symbol}</h1>
          <p className={styles.lede}>
            The ERC-20 paired with aeWETH in the first route the live contracts could execute. It confers no yield,
            equity, revenue claim, governance, or protocol access — every core workflow works without holding it.
            Verify the exact contract on {TOKEN_LAUNCH.network} before you trade it or add it to a wallet.
          </p>

          <section className={styles.facts} id="token" aria-label={`${TOKEN.symbol} token facts`}>
            <div className={styles.fact}>
              <span className={styles.factKey}>Ticker</span>
              <strong className={styles.factValue}>{TOKEN.symbol}</strong>
            </div>
            <div className={styles.fact}>
              <span className={styles.factKey}>Network</span>
              <strong className={styles.factValue}>
                {TOKEN_LAUNCH.network} mainnet · {TOKEN_LAUNCH.chainId}
              </strong>
            </div>
            <div className={styles.fact}>
              <span className={styles.factKey}>Contract</span>
              {/* The address is the highest-stakes string on the site — mistyping
                  it loses funds. Copying it must never require a manual selection. */}
              <span className={styles.factAddress}>
                <code>{TOKEN_LAUNCH.contract}</code>
                <CopyButton
                  label="Copy"
                  title={`Copy the ${TOKEN.symbol} contract address`}
                  value={TOKEN_LAUNCH.contract}
                />
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factKey}>Market</span>
              <strong className={styles.factValue}>
                {TOKEN_LAUNCH.venue} {TOKEN_LAUNCH.version}
              </strong>
            </div>
            <div className={styles.fact}>
              <span className={styles.factKey}>Decimals</span>
              <code className={styles.factMono}>{TOKEN.decimals}</code>
            </div>
          </section>

          <p className={styles.verifyNote}>
            Always verify the network and the full contract address on the site before trading. The token is separate
            from the protocol contracts. Not financial advice. No TVL, yield, or return is implied.
          </p>
        </div>

        <aside className={styles.rail}>
          <section className={styles.tokenCard}>
            <Image
              className={styles.tokenArt}
              src="/0xzaps-token-transparent-200.png"
              alt={TOKEN.symbol}
              width={96}
              height={96}
            />
            <strong className={styles.tokenName}>{TOKEN.symbol}</strong>
            <span className={styles.tokenPair}>paired with aeWETH · v4, 2% hook</span>
            <div className={styles.railActions}>
              {/* The in-app bounded route takes the brand fill: this is an app
                  screen now, and the route that shows its policy before signing
                  is the one we want people to reach first. Clanker stays one
                  tap away rather than being demoted out of view. */}
              <Link className={styles.railPrimary} href={LINKS.buyWithOpenZaps}>
                Zap in to {TOKEN.symbol} <span aria-hidden>→</span>
              </Link>
              <a className={styles.railGhost} href={buyUrl()} target="_blank" rel="noreferrer">
                Buy on {TOKEN_LAUNCH.venue} <span aria-hidden>↗</span>
              </a>
              <TokenUtilities className={styles.railGhost} />
            </div>
          </section>

          <section className={styles.railNote}>
            <h2 className={styles.railNoteTitle}>Where it shows up</h2>
            <div className={styles.railList}>
              <span>· The creation fee converts into it</span>
              <span>· The lottery pot holds it</span>
              <span>· The pinned live route trades it</span>
            </div>
          </section>
        </aside>
      </div>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Three steps to {TOKEN.symbol}</h2>
          <span className={styles.sectionNote}>Both paths identify the same {TOKEN_LAUNCH.network} contract.</span>
        </header>
        <div className={styles.steps}>
          {steps.map((s) => (
            <article className={styles.step} key={s.n}>
              <span className={styles.stepNum}>{s.n}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* `/token#utilities` is linked from the zap console and from
          TokenUtilityPanel; the id is a route, not decoration. */}
      <section className={styles.section} id="utilities">
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Only the utility that exists today</h2>
          <span className={styles.sectionNote}>
            Everything here is live in the app right now. None of it is a protocol right.
          </span>
        </header>
        <div className={styles.rows}>
          {utility.map((u) => (
            <div className={`${styles.row} ${u.danger ? styles.rowDanger : ""}`.trim()} key={u.title}>
              <span className={styles.rowKey}>{u.title}</span>
              <p className={styles.rowBody}>{u.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>One contract, one official market</h2>
          <span className={styles.sectionNote}>
            Anyone can deploy a lookalike. The address is the only thing that tells them apart.
          </span>
        </header>
        <div className={styles.links}>
          {verifyLinks.map((l) => (
            <a className={styles.linkRow} href={l.href} key={l.k} target="_blank" rel="noreferrer">
              <span className={styles.linkKey}>{l.k}</span>
              <strong className={styles.linkValue}>{l.v}</strong>
              <i className={styles.linkArrow} aria-hidden>
                ↗
              </i>
            </a>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Good to know</h2>
        </header>
        <div className={styles.faqs}>
          {faqs.map((f) => (
            <details className={styles.faq} key={f.q}>
              <summary className={styles.faqSummary}>
                {f.q}
                <Glyph name="chevronDown" className={styles.faqChevron} />
              </summary>
              <p className={styles.faqBody}>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.warn}>
          <Glyph name="alert" className={styles.warnGlyph} />
          <p className={styles.warnBody}>
            Live on {TOKEN_LAUNCH.network} mainnet with real funds, and not externally audited. Onchain actions are
            irreversible — deposit only what you can afford to lose.
          </p>
        </div>
        <p className={styles.footNote}>
          Not financial advice. {TOKEN.symbol} is an ERC-20 with no claim on revenue, yield, or assets. It is not equity
          and no return is implied.
        </p>
      </section>
    </main>
  );
}
