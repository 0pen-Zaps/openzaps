import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import { LINKS, TOKEN } from "@/lib/config";
import styles from "./landing.module.css";

/**
 * Landing footer: quiet, structured, typographically aligned. Real
 * destinations only — every column maps to a live route or resource.
 */
export function LandingFooter({ githubUrl }: { githubUrl: string }): React.JSX.Element {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <OpenZapMark className={styles.footerMark} />
          <p className={styles.footerPhrase}>Open execution infrastructure for DeFi.</p>
          <p className={`${styles.footerNote} mono`}>
            Pre-audit software. Nothing here is financial advice.
          </p>
        </div>

        <nav className={styles.footerNav} aria-label="Footer">
          <div className={styles.footerCol}>
            <h3 className={`${styles.footerColTitle} mono`}>Product</h3>
            <Link href="/zap">Zap</Link>
            <Link href="/explore">Explore</Link>
            <Link href="/token">{TOKEN.symbol} token</Link>
            <Link href="/roadmap">Roadmap</Link>
          </div>
          <div className={styles.footerCol}>
            <h3 className={`${styles.footerColTitle} mono`}>Developers</h3>
            <Link href="/docs">Docs</Link>
            <a href={githubUrl} target="_blank" rel="noreferrer noopener">
              GitHub ↗
            </a>
            <a href={LINKS.contractSource} target="_blank" rel="noreferrer noopener">
              Contract source ↗
            </a>
          </div>
          <div className={styles.footerCol}>
            <h3 className={`${styles.footerColTitle} mono`}>Community</h3>
            <a href={LINKS.x} target="_blank" rel="noreferrer noopener">
              X ↗
            </a>
            <a href={LINKS.farcaster} target="_blank" rel="noreferrer noopener">
              Farcaster ↗
            </a>
            <a href={LINKS.dexscreener} target="_blank" rel="noreferrer noopener">
              Dexscreener ↗
            </a>
          </div>
          <div className={styles.footerCol}>
            <h3 className={`${styles.footerColTitle} mono`}>Trust</h3>
            <Link href="/docs#security">Security</Link>
            <Link href="/legal">Risk disclosures</Link>
            <a href="/.well-known/security.txt">security.txt</a>
          </div>
        </nav>
      </div>

      <div className={`container ${styles.footerLegal} mono`}>
        <span>© 2026 OpenZaps</span>
        <span>One transaction. Any protocol.</span>
      </div>
    </footer>
  );
}
