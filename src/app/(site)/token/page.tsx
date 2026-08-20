import Image from "next/image";
import Link from "next/link";

import { CopyButton } from "@/components/CopyButton";
import { Glyph } from "@/components/Glyph";
import { JsonLd } from "@/components/JsonLd";
import { TokenUtilities } from "@/components/TokenUtilities";
import { buyUrl, TOKEN, TOKEN_LAUNCH, LINKS } from "@/lib/config";
import { HOOK_FEE_LABEL } from "@/lib/robinhood";
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
    body: `Use OpenZaps' pinned aeWETH → ${TOKEN.symbol} route or the official Clanker market linked on this page.`,
  },
  {
    n: "02",
    title: "Verify the contract",
    body: `Match the token contract exactly: ${TOKEN_LAUNCH.contract}. A ticker and a logo cost nothing to copy, so check every character of the address, not the first four.`,
  },
  {
    n: "03",
    title: "Review and sign in your wallet",
    body: `Check the exact input, quote, minimum output, and destination on every ${TOKEN_LAUNCH.network} transaction before confirming. OpenZaps shows its bounded policy before execution; Clanker uses its supported market flow.`,
  },
] as const;

/**
 * Where a utility is actually enforced. This is the distinction the page exists
 * to keep honest: `contracts` utilities hold because a deployed immutable says
 * so, `app` ones are conveniences 0xzaps.com chooses to grant and could stop
 * granting tomorrow. Collapsing the two into one undifferentiated list is how a
 * token page starts implying protocol rights it does not confer.
 */
const WHERE = {
  contracts: "Onchain",
  app: "App only",
  wallet: "Wallet",
} as const;

const utility: readonly { title: string; where: keyof typeof WHERE; body: string }[] = [
  {
    title: "The asset in the pinned live routes",
    where: "contracts",
    body: "The bounded adapter is welded to one Uniswap v4 pool — aeWETH ↔ 0xZAPS, both directions, one deployed contract — and cannot route to another token, spender, hook, or DEX. Two stitched adapters trade 0xZAPS against USDG, one per direction, by pairing that pool with the hookless aeWETH ↔ USDG one. Every pool an adapter may touch is a constructor immutable, so an execution cannot wander off them.",
  },
  {
    title: "The creation fee converts into it",
    where: "contracts",
    body: `Every Zap created through the app-creation fee gateway pays its native fee, and the immutable gateway converts that fee through the same pinned aeWETH → ${TOKEN.symbol} route the app quotes for you. The conversion is part of the creation transaction, not a later discretionary step.`,
  },
  {
    title: "The lottery pot accrues and holds it",
    where: "contracts",
    body: `Eighty percent of the automation fee goes to whoever submitted the run; the remaining twenty accrues to the pot and becomes ${TOKEN.symbol} once anyone converts it. The pot's balance is readable onchain and shown live on /pot.`,
  },
  {
    title: "App conveniences at a balance threshold",
    where: "app",
    body: "Hold 100,000+ 0xZAPS in the connected wallet and the app auto-refreshes live quotes, keeps 50 saved Zaps instead of 20, retains 100 receipts instead of 20, and enables receipt JSON export. At 1,000,000+ the saved-Zap limit is 100. The app reads the balance; the contracts never do.",
  },
  {
    title: "The first fixed fee campaign has fixed dates",
    where: "contracts",
    body: "The first 0xZAPS fee rewards campaign is fixed to a seven-day Aug 3–10, 2026 staking window. It was funded at launch with 50 of 100 tokenized Clanker fee shares and is configured to use time-weighted stake to allocate campaign-accounted WETH to eligible deposits during that window. Its harvest path was configured for Clanker fees, while direct WETH transfers can also be synchronized; this site never asks for or spends sponsor-wallet WETH. Holding the token outside that contract earns nothing. Check /rewards for the current phase, live principal, and later claim deadline.",
  },
  {
    title: "Wallet-readable ERC-20",
    where: "wallet",
    body: `Use the exact ${TOKEN_LAUNCH.network} address, ${TOKEN.decimals} decimals, and the add-to-wallet button on this page. Wallet support varies.`,
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
    a: "No. Creating, funding, executing, and recovering a Zap contract all work without holding 0xZAPS. Holding 100,000+ 0xZAPS turns on app conveniences — auto-refreshing quotes, more saved Zaps and receipts, and receipt JSON export — which the app checks against the connected wallet's balance. The contracts do not read it.",
  },
  {
    q: "Are the contracts audited?",
    a: "No external audit is published for any of the OpenZaps protocol contracts. Deposited funds are at risk. Onchain actions are irreversible.",
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
          {/* Keyword-bearing h1: the page targets "0xZAPS token" / "0xZAPS
              contract", so the highest-weight heading carries the term while the
              ticker keeps its gradient treatment via the span. */}
          <h1 className={styles.title}>
            <span className="gradientText">{TOKEN.symbol}</span> token
          </h1>
          <p className={styles.lede}>
            The ERC-20 paired with aeWETH in the protocol&apos;s first live route. Ownership alone confers no yield,
            equity, revenue claim, governance, or protocol access — every core workflow works without holding it. The
            first 0xZAPS fee rewards campaign has a fixed seven-day Aug 3–10, 2026 staking window and a later claim
            deadline. Check the current phase on /rewards, then verify the exact token and campaign contracts on{" "}
            {TOKEN_LAUNCH.network} before signing.
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
            Always match the network and the full contract address against this page before trading. The token is
            separate from the protocol contracts. Not financial advice. No TVL, yield, or return is implied.
          </p>
        </div>

        <aside className={styles.rail}>
          <section className={styles.tokenCard}>
            {/* The opaque asset, not the transparent one. The mark is lime on
                black; dropped transparent onto `--panel` it is near-invisible
                on Ivory and Paper. A token logo is a brand asset rather than
                themed UI, so it brings its own ground and stays legible on all
                five themes — the radius is the only part that themes. */}
            <Image
              className={styles.tokenArt}
              src={TOKEN.logoPath}
              alt={TOKEN.symbol}
              width={128}
              height={128}
            />
            <strong className={styles.tokenName}>{TOKEN.symbol}</strong>
            <span className={styles.tokenPair}>paired with aeWETH · v4, {HOOK_FEE_LABEL} hook</span>
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

          {/* These three were prose bullets that restated the utility rows
              below. They are now the rows themselves, so this card links to
              them rather than keeping a second copy that can drift. */}
          <section className={styles.railNote}>
            <h2 className={styles.railNoteTitle}>Where it shows up</h2>
            <div className={styles.railList}>
              <span>· The pinned live routes trade it</span>
              <span>· The creation fee converts into it</span>
              <span>· The lottery pot accrues it</span>
              <span>· First fee campaign: Aug 3–10, 2026</span>
            </div>
            <Link className={styles.railNoteLink} href="/token#utilities">
              All token utility <span aria-hidden>↓</span>
            </Link>
            <br />
            <Link className={styles.railNoteLink} href="/rewards">
              Check campaign phase <span aria-hidden>→</span>
            </Link>
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
          <h2 className={styles.sectionTitle}>How {TOKEN.symbol} is used</h2>
          <span className={styles.sectionNote}>
            Each row names its enforcement; the first fee campaign also states its fixed dates.
          </span>
        </header>
        <div className={styles.rows}>
          {utility.map((u) => (
            <div className={styles.row} key={u.title}>
              <span className={styles.rowKey}>
                {u.title}
                <em className={styles.rowWhere} data-where={u.where}>
                  {WHERE[u.where]}
                </em>
              </span>
              <p className={styles.rowBody}>{u.body}</p>
            </div>
          ))}
          {/* Deliberately the last row and deliberately loud: everything above
              is a reason to hold the token, and this is the boundary on all of
              it. Moving it out of this list detaches it from what it limits. */}
          <div className={`${styles.row} ${styles.rowDanger}`}>
            <span className={styles.rowKey}>What it does not grant</span>
            <p className={styles.rowBody}>
              Ownership alone grants no protocol governance, automatic staking benefit, revenue claim, yield, equity,
              or fee right. The first campaign recognizes only eligible deposits made during its fixed Aug 3–10, 2026
              staking window, with a later claim deadline shown on /rewards. Every core workflow — create, fund,
              execute, recover — works without holding it, and the app conveniences above are not protocol rights.
            </p>
          </div>
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
            Live on {TOKEN_LAUNCH.network} mainnet with real funds. Onchain actions are
            irreversible — deposit only what you can afford to lose.
          </p>
        </div>
        <p className={styles.footNote}>
          Not financial advice. {TOKEN.symbol} ownership alone has no claim on revenue, yield, or assets. The first fee
          campaign accounts WETH under its fixed terms and Aug 3–10, 2026 staking window. Its harvest path was
          configured for Clanker fees, but direct WETH transfers can also be synchronized. Check /rewards for
          the current phase and later claim deadline. It is not equity and no return is implied.
        </p>
      </section>
    </main>
  );
}
