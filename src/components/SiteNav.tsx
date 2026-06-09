"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OpenZapMark } from "./OpenZapMark";
import { BuyButton } from "./BuyButton";
import { TOKEN } from "@/lib/config";
import styles from "./SiteNav.module.css";

const LINKS = [
  { href: "/token", label: TOKEN.symbol },
  { href: "/app", label: "App" },
  { href: "/#protocol", label: "Protocol" },
  { href: "/#security", label: "Security" },
] as const;

export function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <header className={styles.wrap}>
      <nav className={styles.nav} aria-label="Primary">
        <Link href="/" className={styles.brand} aria-label="OpenZaps home">
          <OpenZapMark className={styles.mark} />
          <span className={styles.word}>OpenZaps</span>
          <span className={styles.ticker}>{TOKEN.symbol}</span>
        </Link>
        <div className={styles.links}>
          {LINKS.map((l) => {
            const active = !l.href.includes("#") && pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={active ? styles.active : undefined}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <BuyButton className={styles.cta} />
      </nav>
    </header>
  );
}
