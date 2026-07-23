"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { OpenZapMark } from "./OpenZapMark";
import { BuyButton } from "./BuyButton";
import { ScrollProgress } from "./ScrollProgress";
import { TOKEN } from "@/lib/config";
import styles from "./SiteNav.module.css";

const LINKS = [
  { href: "/use", label: "Use" },
  { href: "/zaps", label: "Zaps Feed" },
  { href: "/docs", label: "Docs" },
  { href: "/token", label: TOKEN.symbol },
] as const;

export function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  const [condensed, setCondensed] = useState(false);
  const barRef = useRef<HTMLElement>(null);

  /**
   * Publish this bar's height as `--nav-h` for anything that has to sit below it.
   *
   * The height is not a constant anyone can hard-code: below 920px the nav wraps
   * its links onto a second row, and condensing trims the padding on every
   * scroll. Sticky rails around the site each guessed a fixed offset instead,
   * and the guesses were wrong — the builder's mobile block tray assumed 4.2rem
   * against a two-row bar that is over 100px tall, so it stuck itself underneath
   * the nav and hid its own heading. One measured value keeps them all honest.
   */
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const publish = (): void => {
      document.documentElement.style.setProperty("--nav-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

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
    <header ref={barRef} className={styles.wrap} data-condensed={condensed}>
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
