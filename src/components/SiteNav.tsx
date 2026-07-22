"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { OpenZapMark } from "./OpenZapMark";
import { BuyButton } from "./BuyButton";
import { ScrollProgress } from "./ScrollProgress";
import { TOKEN } from "@/lib/config";
import styles from "./SiteNav.module.css";

const LINKS = [
  { href: "/app", label: "App" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/docs", label: "Docs" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
  { href: "/token", label: TOKEN.symbol },
] as const;

export function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  const [condensed, setCondensed] = useState(false);

  // Condense the bar once the page has moved at all: the nav gives back
  // vertical space and deepens its backdrop so content reads over it cleanly.
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      setCondensed(window.scrollY > 12);
    };
    const onScroll = (): void => {
      frame ||= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header className={styles.wrap} data-condensed={condensed}>
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
                <span>{l.label}</span>
              </Link>
            );
          })}
        </div>
        <BuyButton className={styles.cta} />
      </nav>
      <ScrollProgress />
    </header>
  );
}
