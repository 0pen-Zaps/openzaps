import Link from "next/link";
import { OpenZapMark } from "./OpenZapMark";
import { LINKS, TOKEN, CHAIN } from "@/lib/config";
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
                Immutable intent lockers for agent-triggered DeFi. {TOKEN.symbol} launching on pool.fans.
              </p>
            </div>
          </div>
          <p className={styles.note}>
            Pre-audit reference implementation on {CHAIN.name}. Not financial advice; no live TVL,
            yield, or returns are implied.
          </p>
        </div>

        <nav className={styles.cols} aria-label="Footer">
          <div className={styles.col}>
            <h3>Product</h3>
            <Link href="/token">{TOKEN.symbol} token</Link>
            <Link href="/app">Open the app</Link>
            <Link href="/#protocol">How it works</Link>
          </div>
          <div className={styles.col}>
            <h3>Build</h3>
            <a href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link href="/#security">Security</Link>
          </div>
          <div className={styles.col}>
            <h3>Token</h3>
            <a href={LINKS.buy} target="_blank" rel="noreferrer">
              Buy on pool.fans
            </a>
            <a href={LINKS.poolfans} target="_blank" rel="noreferrer">
              pool.fans/openzaps
            </a>
          </div>
        </nav>
      </div>

      <div className={styles.legal}>
        <span>© 2026 OpenZaps</span>
        <span>
          {TOKEN.symbol} · {CHAIN.name}
        </span>
      </div>
    </footer>
  );
}
