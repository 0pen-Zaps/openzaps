import Link from "next/link";
import { ZapLinesLockup } from "@/components/ZapLinesMark";
import { TOKEN, TOKEN_LAUNCH, CHAIN, buyUrl } from "@/lib/config";
import styles from "./lines.module.css";

/**
 * Navigation shared by every LINES page.
 *
 * The routes listed here are the ones that exist inside the preview. The live
 * product surfaces — the app, the dashboard, per-capsule pages — are reached
 * through `EXTERNAL` and deliberately point at the real site rather than being
 * restyled here: those read live chain state, and a preview that invented
 * balances or execution counts to look complete would be lying about onchain
 * data. A design preview is allowed to be partial; it is not allowed to be
 * fictional.
 */
const ROUTES = [
  { href: "/lines/build", label: "Build" },
  { href: "/lines/security", label: "Security" },
  { href: "/lines/docs", label: "Docs" },
  { href: "/lines/pricing", label: "Pricing" },
  { href: "/lines/token", label: TOKEN.symbol },
  { href: "/lines/roadmap", label: "Roadmap" },
] as const;

export function LinesRibbon(): React.JSX.Element {
  return (
    <div className={styles.ribbon}>
      <span>Preview · LINES identity</span>
      {/* A plain anchor, not a Link. Replaying needs a real document load so
          the guard script in the root layout runs again; a client-side
          navigation swaps the URL without re-executing it, and the intro would
          stay suppressed. */}
      <a href="/lines?intro=1">Replay intro</a>
      <Link href="/">Back to the current site</Link>
    </div>
  );
}

export function LinesNav({ current }: { current?: string }): React.JSX.Element {
  return (
    <header className={styles.shell}>
      <nav className={styles.nav} aria-label="Primary">
        <Link href="/lines" className={styles.brandLink} aria-label="LINES preview home">
          <ZapLinesLockup className={styles.brand} motion="charge" />
        </Link>
        <div className={styles.navLinks}>
          {ROUTES.map((route) => {
            const active = route.href === current;
            return (
              <Link
                key={route.href}
                href={route.href}
                className={active ? styles.navActive : undefined}
                aria-current={active ? "page" : undefined}
              >
                {route.label}
              </Link>
            );
          })}
        </div>
        <a className={styles.btnGhost} href={buyUrl()} target="_blank" rel="noreferrer">
          Buy ${TOKEN.symbol}
        </a>
      </nav>
    </header>
  );
}

export function LinesFooter(): React.JSX.Element {
  return (
    <footer className={styles.shell}>
      <p className={styles.disclaimer}>
        ${TOKEN.symbol} lives on {TOKEN_LAUNCH.network}. The OpenZaps reference protocol contracts are separately
        deployed on {CHAIN.name} and remain pre-audit. Not financial advice; no TVL, yield, or returns are implied.
        This page is a design preview — the live app, dashboard and capsule pages stay on the current site.
      </p>
      <div className={styles.footer}>
        <ZapLinesLockup />
        <div className={styles.footerLinks}>
          <Link href="/app">Live app</Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/zaps">Capsules</Link>
          <Link href="/legal">Legal</Link>
        </div>
        <span className={styles.mono}>One bounded route</span>
      </div>
    </footer>
  );
}
