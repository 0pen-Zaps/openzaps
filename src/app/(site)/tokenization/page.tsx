import Link from "next/link";

import { JsonLd } from "@/components/JsonLd";
import { CHAIN } from "@/lib/config";
import { STATIC_PAGE_SEO, breadcrumbJsonLd, pageMetadata, webPageJsonLd } from "@/lib/seo";

import styles from "./tokenization.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.tokenization,
  keywords: [
    "tokenize creator fees",
    "Uniswap Instant Launch fees",
    "fractionalize LP fees",
    "FEEB NFT",
    "creator revenue",
    "Robinhood Chain DeFi",
    "fee vaults",
    "UFEE tokens",
  ],
});

const FACTORY_ADDRESS = "0x51dEae9a3D7b21fe9CE093167008c833206fB760";

export default function TokenizationPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main" data-screen-label="Tokenization">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.tokenization),
            breadcrumbJsonLd("/tokenization", "Tokenization"),
            {
              "@type": "TechArticle",
              headline: "Fractionalize Uniswap Instant Launch creator fees into liquid ERC20 tokens",
              description: STATIC_PAGE_SEO.tokenization.description,
              dateModified: "2026-08-05",
              author: { "@type": "Organization", name: "OpenZaps" },
            },
          ],
        }}
      />

      <section className={styles.hero}>
        <p className={styles.eyebrow}>
          <span aria-hidden />
          OpenZaps feature · August 2026
        </p>
        <h1>Tokenize your creator fees.</h1>
        <p className={styles.heroLead}>
          Uniswap Instant Launch gives creators 40% of LP trading fees — locked in an NFT.
          OpenZaps fractionalizes that claim into liquid ERC20 tokens. Sell, trade, or
          borrow against your future fee stream on {CHAIN.name}.
        </p>
        <div className={styles.heroMeta}>
          <span className={styles.badge}>
            <span className={styles.badgeDot} aria-hidden />
            Live on {CHAIN.name}
          </span>
          <a
            href={`${CHAIN.explorer}/address/${FACTORY_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
            className={styles.badge}
          >
            Factory: {FACTORY_ADDRESS.slice(0, 8)}&hellip;{FACTORY_ADDRESS.slice(-6)}
            <span aria-hidden> ↗</span>
          </a>
        </div>
        <div className={styles.heroActions}>
          <Link className={styles.primaryBtn} href="/zap?view=start">
            Create a Zap
          </Link>
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>How it works</span>
          <h2>Four steps from launch to liquid fee stream.</h2>
        </header>

        {[
          {
            num: "01",
            title: "Launch on Uniswap",
            tag: "Instant Launch",
            body: "A creator launches a token on Uniswap Instant Launch with creator fees enabled. One transaction mints the token, initializes the pool, and a FEEB ERC721 NFT is minted — proving the creator is the beneficiary of 40% of native ETH LP trading fees.",
          },
          {
            num: "02",
            title: "Deposit into a vault",
            tag: "Fractionalize",
            body: "The creator deposits their FEEB NFT into the UniFees vault factory. The NFT is permanently locked, and 1,000,000,000 ERC20 shares (UFEE-TOKEN) are minted. The creator can sell shares, keep them, or allocate to a treasury.",
          },
          {
            num: "03",
            title: "Earn & harvest",
            tag: "Permissionless",
            body: "Every swap on the token's Uniswap pool generates LP fees. 40% of native ETH accrues to the vault. Anyone can call harvest() to distribute accumulated ETH pro-rata to all UFEE-TOKEN holders — shares on the open market earn too.",
          },
          {
            num: "04",
            title: "Protocol flywheel",
            tag: "Self-reinforcing",
            body: "100% of protocol fees — from vault deployments, harvests, and tokenizations — are used to market-buy $0xZAPS. More activity → more fees → more buy pressure → more protocol value capturing every creator's fee stream.",
          },
        ].map((step) => (
          <div className={styles.stepRow} key={step.num}>
            <div className={styles.stepNum}>
              <div className={styles.stepCircle}>{step.num}</div>
              <h3>{step.title}</h3>
              <p>{step.tag}</p>
            </div>
            <div className={styles.stepBody}>
              <p>{step.body}</p>
            </div>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>Deployed contract</span>
          <h2>Factory live on {CHAIN.name}.</h2>
        </header>
        <div className={styles.contractCard}>
          <div className={styles.contractRow}>
            <span>Contract</span>
            <a href={`${CHAIN.explorer}/address/${FACTORY_ADDRESS}`} target="_blank" rel="noreferrer">
              {FACTORY_ADDRESS.slice(0, 10)}&hellip;{FACTORY_ADDRESS.slice(-8)}↗
            </a>
          </div>
          <div className={styles.contractRow}>
            <span>Chain</span>
            <span>{CHAIN.name} ({CHAIN.id})</span>
          </div>
          <div className={styles.contractRow}>
            <span>Type</span>
            <span>UniswapInstantBeneficiaryVaultFactory</span>
          </div>
          <div className={styles.contractRow}>
            <span>Powered by</span>
            <span>Uniswap Instant Launch</span>
          </div>
        </div>
      </section>
    </main>
  );
}