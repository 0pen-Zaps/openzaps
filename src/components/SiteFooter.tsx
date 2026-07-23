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
                Policy capsules for agent-triggered DeFi: the target, recipient, asset, and calldata are fixed before
                signing. {TOKEN.symbol} is the ERC-20 in the protocol&apos;s first live route, traded through {TOKEN_LAUNCH.venue} on{" "}
                {TOKEN_LAUNCH.network}.
              </p>
            </div>
          </div>
          <p className={styles.note}>
            {TOKEN.symbol} is on {TOKEN_LAUNCH.network}. The OpenZaps protocol contracts are deployed on {CHAIN.name}{" "}
            and have not been externally audited. Onchain actions are irreversible. Not financial advice. No TVL, yield,
            or return is implied.
          </p>
        </div>

        <nav className={styles.cols} aria-label="Footer">
          <div className={styles.col}>
            <h3>Product</h3>
            <Link href="/zap">Zap</Link>
            <Link href="/explore">Explore</Link>
            <Link href="/docs">Developer docs</Link>
            <Link href="/roadmap">Roadmap</Link>
          </div>
          <div className={styles.col}>
            <h3>Build</h3>
            <a href={LINKS.contractSource} target="_blank" rel="noreferrer">
              Contract source
            </a>
            <a href={LINKS.x} target="_blank" rel="noreferrer">
              X @0xzaps
            </a>
            <Link href="/docs#security">Security</Link>
            <Link href="/zap">Visual builder</Link>
          </div>
          <div className={styles.col}>
            <h3>Token</h3>
            <Link href="/token">{TOKEN.symbol} token</Link>
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
