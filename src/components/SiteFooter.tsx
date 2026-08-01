import Link from "next/link";
import { OpenZapMark } from "./OpenZapMark";
import { LINKS, TOKEN, TOKEN_LAUNCH, CHAIN } from "@/lib/config";
import styles from "./SiteFooter.module.css";

export function SiteFooter(): React.JSX.Element {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brandCol}>
          <div className={styles.brand}>
            <OpenZapMark className={styles.mark} />
            <div>
              <strong>OpenZaps</strong>
              {/* The product's one-line definition, and the only place it
                  appears outside /docs — so it is what someone landing on
                  /token or /explore reads first. "Zaps for agent-triggered
                  DeFi" would be circular against the brand name, which is why
                  the term it replaces stays here in apposition. */}
              {/* The explicit {" "} is not noise. A JSXText node that spans
                  lines loses the space between an interpolation and the word
                  after it, so `{TOKEN.symbol} is` renders as "0xZAPSis". The
                  rest of this file already used the same guard. */}
              <p>
                Zaps are immutable policy capsules for agent-triggered DeFi: the target, recipient, asset, and calldata
                are fixed before signing. {TOKEN.symbol}{" "}
                is the ERC-20 in the protocol&apos;s first live route, traded through {TOKEN_LAUNCH.venue} on{" "}
                {TOKEN_LAUNCH.network}.
              </p>
            </div>
          </div>
          <p className={styles.note}>
            {TOKEN.symbol} is on {TOKEN_LAUNCH.network}. The OpenZaps protocol contracts are deployed on {CHAIN.name}.
            Onchain actions are irreversible. Not financial advice. No TVL, yield, or return is implied.
          </p>
        </div>

        {/* h2, not h3. The app shell renders this footer under every screen,
            and a screen whose only heading is its h1 — the disconnected My
            zaps state, for one — then jumped straight to h3, breaking the
            document outline on a route that had done nothing wrong. */}
        <nav className={styles.cols} aria-label="Footer">
          <div className={styles.col}>
            <h2>Product</h2>
            <Link href="/zap">Zap</Link>
            <Link
              href="/request-a-zap"
              data-analytics-event="request_zap_clicked"
              data-analytics-cta="request_zap"
              data-analytics-content="site_footer"
            >
              Request a Zap
            </Link>
            <Link href="/explore">Explore</Link>
            <Link href="/docs">Developer docs</Link>
            <Link href="/roadmap">Roadmap</Link>
          </div>
          <div className={styles.col}>
            <h2>Build</h2>
            <a
              href={LINKS.contractSource}
              target="_blank"
              rel="noreferrer"
              data-analytics-event="growth_link_clicked"
              data-analytics-cta="github"
              data-analytics-content="site_footer"
            >
              Contract source
            </a>
            <a
              href={LINKS.x}
              target="_blank"
              rel="noreferrer"
              data-analytics-event="growth_link_clicked"
              data-analytics-cta="x"
              data-analytics-content="site_footer"
            >
              X @0xzaps
            </a>
            <a
              href={LINKS.discord}
              target="_blank"
              rel="noreferrer"
              data-analytics-event="growth_link_clicked"
              data-analytics-cta="discord"
              data-analytics-content="site_footer"
            >
              Discord
            </a>
            <a
              href={LINKS.substack}
              target="_blank"
              rel="noreferrer"
              data-analytics-event="growth_link_clicked"
              data-analytics-cta="substack"
              data-analytics-content="site_footer"
            >
              DeFi Tutorials
            </a>
            <Link href="/docs#security">Security</Link>
            <Link href="/zap">Visual builder</Link>
          </div>
          <div className={styles.col}>
            <h2>Token</h2>
            <Link href="/token">{TOKEN.symbol} token</Link>
            <Link href={LINKS.buyWithOpenZaps}>Zap in with OpenZaps</Link>
            <a href={LINKS.buy} target="_blank" rel="noreferrer">
              Buy on Clanker
            </a>
            <a href={LINKS.dexscreener} target="_blank" rel="noreferrer">
              View on Dexscreener
            </a>
            <a href={LINKS.tokenExplorer} target="_blank" rel="noreferrer">
              View token contract
            </a>
            <Link href="/legal">Risk disclosures</Link>
          </div>
        </nav>
      </div>

      <div className={styles.legal}>
        <span>© 2026 OpenZaps</span>
        <span>
          {TOKEN.symbol} · {TOKEN_LAUNCH.network}
        </span>
      </div>
    </footer>
  );
}
