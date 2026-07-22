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
              <p>
                Bounded policy capsules for agent-triggered DeFi. ${TOKEN.symbol} is live on {TOKEN_LAUNCH.network}
                through {TOKEN_LAUNCH.venue}.
              </p>
            </div>
          </div>
          <p className={styles.note}>
            {TOKEN.symbol} lives on {TOKEN_LAUNCH.network}. OpenZaps reference protocol contracts are separately
            deployed on {CHAIN.name} and remain pre-audit. Not financial advice; no live TVL, yield, or returns are
            implied.
          </p>
        </div>

        <nav className={styles.cols} aria-label="Footer">
          <div className={styles.col}>
            <h3>Product</h3>
            <Link href="/app">Open the app</Link>
            <Link href="/docs">Developer docs</Link>
            <Link href="/roadmap">Roadmap</Link>
          </div>
          <div className={styles.col}>
            <h3>Build</h3>
            <a href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link href="/security">Security</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div className={styles.col}>
            <h3>Token</h3>
            <Link href="/token">{TOKEN.symbol} token</Link>
            <a href={LINKS.buy} target="_blank" rel="noreferrer">
              Buy on Clanker
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
