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
    "fee tokenization",
    "FEEB NFT",
    "creator revenue",
    "Robinhood Chain DeFi",
    "fee vaults",
    "UFEE tokens",
    "UniFees",
  ],
});

const FACTORY_ADDRESS = "0x51dEae9a3D7b21fe9CE093167008c833206fB760";
const FACTORY_EXPLORER = `${CHAIN.explorer}/address/${FACTORY_ADDRESS}`;

const STEPS = [
  {
    number: "01",
    title: "Launch on Uniswap",
    tag: "Instant Launch",
    body: (
      <>
        <p>
          A creator launches a token on Uniswap Instant Launch with{" "}
          <strong>creator fees enabled</strong>. One transaction mints the token, initializes the
          pool, and provisions liquidity — and a FEEB ERC721 NFT is minted, proving the creator is
          the beneficiary of 40% of native ETH LP trading fees.
        </p>
        <div className={styles.codeBlock}>
          <div className={styles.label}>{/* Launch parameters */}</div>
          <div>
            <span className={styles.accent}>Token:</span> 1,000,000,000 supply
          </div>
          <div>
            <span className={styles.accent}>Pool:</span> TOKEN/ETH · 0.25% fee tier · instant
            liquidity
          </div>
          <div>
            <span className={styles.accent}>Creator Fees:</span> enabled → 40% native ETH to
            creator
          </div>
          <div className={styles.ok}>
            ✓ Pool created · ✓ LP position minted · ✓ FEEB NFT minted
          </div>
        </div>
      </>
    ),
  },
  {
    number: "02",
    title: "Wrap into a Fee Vault",
    tag: "Fractionalize",
    body: (
      <>
        <p>
          The creator deposits their FEEB NFT into the UniFees vault factory. The NFT is{" "}
          <strong>permanently locked</strong>, and 1,000,000,000 ERC20 shares (UFEE-TOKEN) are
          minted. The creator can sell shares to investors, keep them, or allocate to a treasury —
          raising upfront capital while the community shares in the pool&apos;s success.
        </p>
        <div className={styles.codeBlock}>
          <div className={styles.label}>{/* Vault creation */}</div>
          <div>
            <span className={styles.accent}>Action:</span> Deposit FEEB NFT → Vault
          </div>
          <div>
            <span className={styles.accent}>Shares Minted:</span> 1,000,000,000 UFEE-TOKEN
          </div>
          <div>
            <span className={styles.accent}>Split:</span> Creator 70% · Investors 20% · Treasury 10%
          </div>
          <div className={styles.ok}>
            ✓ NFT locked permanently · ✓ ERC20 shares minted
          </div>
        </div>
      </>
    ),
  },
  {
    number: "03",
    title: "Earn & Harvest",
    tag: "Permissionless",
    body: (
      <>
        <p>
          Every swap on the token&apos;s Uniswap pool generates LP fees. The FeeSplitter collects
          them — 40% of native ETH is attributed to the vault.{" "}
          <strong>Anyone can call harvest()</strong> to distribute accumulated ETH pro-rata to all
          UFEE-TOKEN holders. Shares on the open market earn too, creating natural buy pressure.
        </p>
        <div className={styles.codeBlock}>
          <div className={styles.label}>{/* After 1 week of trading */}</div>
          <div>
            <span className={styles.accent}>Volume:</span> $2.4M across 18,000 swaps
          </div>
          <div>
            <span className={styles.accent}>LP Fees Generated:</span> 6 ETH (0.25% fee tier)
          </div>
          <div>
            <span className={styles.accent}>Creator Share (40%):</span> 2.4 ETH accrued to vault
          </div>
          <div className={styles.ok}>
            ✓ Anyone calls harvest() → 2.4 ETH distributed
          </div>
        </div>
      </>
    ),
  },
  {
    number: "04",
    title: "Protocol Flywheel",
    tag: "Self-reinforcing",
    body: (
      <>
        <p>
          UniFees charges a small protocol fee on vault deployments, harvests, and tokenizations.{" "}
          <strong>100% of these fees are used to market-buy the protocol token</strong>,
          creating a self-reinforcing flywheel: more activity → more fees → more buy pressure → more
          protocol value capturing every creator&apos;s fee stream.
        </p>
        <div className={styles.codeBlock}>
          <div className={styles.label}>{/* Protocol fee flow */}</div>
          <div>
            <span className={styles.accent}>Vault Creation:</span> 0.0001 ETH → market buy protocol
            token
          </div>
          <div>
            <span className={styles.accent}>Each Harvest:</span> 1% of harvested amount → market buy
            protocol token
          </div>
          <div>
            <span className={styles.accent}>Tokenization:</span> 1% of minted shares → market buy
            protocol token
          </div>
          <div className={styles.ok}>
            ✓ More activity → more fees → more buy pressure
          </div>
        </div>
      </>
    ),
  },
];

const FLYWHEEL_ITEMS = [
  {
    label: "Vault Deployments",
    desc: "0.0001 ETH per new vault feeds the flywheel",
  },
  {
    label: "Fee Harvests",
    desc: "1% of each harvest feeds the flywheel",
  },
  {
    label: "Tokenizations",
    desc: "1% of minted shares feeds the flywheel",
  },
];

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
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            OpenZaps feature · August 2026
          </p>
          <h1>Tokenize your creator fees.</h1>
          <p className={styles.heroLead}>
            Uniswap Instant Launch gives creators 40% of LP trading fees — locked in an NFT. This
            feature fractionalizes that claim into liquid ERC20 tokens. Sell, trade, or borrow
            against your future fee stream on {CHAIN.name}.
          </p>
          <div className={styles.heroMetaRow}>
            <span className={styles.heroBadge}>
              <span className={styles.heroBadgeDot} aria-hidden />
              Live on {CHAIN.name}
            </span>
            <a
              href={FACTORY_EXPLORER}
              target="_blank"
              rel="noreferrer"
              className={styles.heroBadge}
            >
              Factory: {FACTORY_ADDRESS.slice(0, 8)}&hellip;{FACTORY_ADDRESS.slice(-6)}
              <span aria-hidden> ↗</span>
            </a>
          </div>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/zap?view=start">
              Create a Zap
            </Link>
            <a
              className={styles.secondaryAction}
              href={FACTORY_EXPLORER}
              target="_blank"
              rel="noreferrer"
            >
              View contract
            </a>
          </div>
        </div>

        <aside className={styles.heroPosture} aria-label="Feature status">
          <span className={styles.heroPostureLabel}>Status</span>
          <strong>Live on Robinhood Chain. Factory deployed and verified.</strong>
          <p>
            The UniFees factory contract fractionalizes Uniswap Instant Launch FEEB NFTs into
            ERC20 tokens. Vault creation, fee harvesting, and tokenization are all available
            onchain.
          </p>
          <ul>
            <li>Powered by Uniswap Instant Launch creator fees.</li>
            <li>FEEB NFTs are permanently locked; ERC20 shares are liquid.</li>
            <li>Protocol fees create a self-reinforcing flywheel.</li>
          </ul>
        </aside>

        <div className={styles.heroFlow} aria-label="Tokenization flow">
          {["Launch token", "Deposit FEEB NFT", "Mint ERC20 shares", "Harvest ETH fees", "Protocol flywheel"].map(
            (step, index) => (
              <div key={step}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
                {index < 4 ? <i aria-hidden>→</i> : null}
              </div>
            ),
          )}
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>How it works</span>
          <h2>From token launch to liquid fee stream.</h2>
          <p>
            A real walkthrough: creator fees are locked in an NFT at launch. The NFT goes into a
            vault, ERC20 shares are minted, and every swap on the pool distributes ETH pro-rata to
            shareholders. Anyone can harvest — no permission needed.
          </p>
        </header>

        {STEPS.map((step) => (
          <div className={styles.stepRow} key={step.number}>
            <div className={styles.stepNumber}>
              <div className={styles.stepCircle}>{step.number}</div>
              <h3>{step.title}</h3>
              <p>{step.tag}</p>
            </div>
            <div className={styles.stepBody}>{step.body}</div>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>Protocol flywheel</span>
          <h2>Every action feeds back into the protocol.</h2>
          <p>
            100% of protocol fees — from vault deployments, fee harvests, and tokenizations — are
            used to market-buy the protocol token. More creators, more vaults, more harvests all
            drive the same flywheel.
          </p>
        </header>

        <div className={styles.flywheelGrid}>
          {FLYWHEEL_ITEMS.map((item) => (
            <div className={styles.flywheelCard} key={item.label}>
              <div className={styles.flywheelArrow}>→</div>
              <strong>{item.label}</strong>
              <span>{item.desc}</span>
            </div>
          ))}
        </div>

        <div className={styles.contractCard}>
          <h3>Deployed factory</h3>
          <div className={styles.contractRow}>
            <dt>Contract</dt>
            <dd>
              <a href={FACTORY_EXPLORER} target="_blank" rel="noreferrer">
                {FACTORY_ADDRESS.slice(0, 10)}&hellip;{FACTORY_ADDRESS.slice(-8)}↗
              </a>
            </dd>
          </div>
          <div className={styles.contractRow}>
            <dt>Chain</dt>
            <dd>
              {CHAIN.name} ({CHAIN.id})
            </dd>
          </div>
          <div className={styles.contractRow}>
            <dt>Type</dt>
            <dd>UniswapInstantBeneficiaryVaultFactory</dd>
          </div>
          <div className={styles.contractRow}>
            <dt>Powered by</dt>
            <dd>Uniswap Instant Launch</dd>
          </div>
          <div className={styles.contractActions}>
            <a
              href={FACTORY_EXPLORER}
              target="_blank"
              rel="noreferrer"
              className={styles.secondaryAction}
            >
              View on explorer ↗
            </a>
          </div>
        </div>
      </section>

      <section className={styles.ctaSection}>
        <h2>Ready to tokenize your fees?</h2>
        <p>
          Deploy a vault, deposit your FEEB NFT, and mint liquid ERC20 tokens — all on{" "}
          {CHAIN.name}.
        </p>
        <div className={styles.ctaActions}>
          <Link className={styles.primaryAction} href="/zap?view=start">
            Start a Zap
          </Link>
          <a
            className={styles.secondaryAction}
            href={`${CHAIN.explorer}/address/${FACTORY_ADDRESS}?tab=contract`}
            target="_blank"
            rel="noreferrer"
          >
            Read the contract ↗
          </a>
        </div>
      </section>
    </main>
  );
}