"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { OpenZapMark } from "@/components/OpenZapMark";
import styles from "./landing.module.css";

/**
 * Fixed landing navigation. Transparent over the hero; after ~half a screen
 * of scroll it condenses onto dark glass with a yellow hairline. Section
 * links scroll-spy via one IntersectionObserver.
 */

const SECTIONS = [
  { id: "product", label: "Product" },
  { id: "zaps", label: "Zaps" },
  { id: "developers", label: "Developers" },
  { id: "integrations", label: "Integrations" },
] as const;

export function LandingNav({ githubUrl }: { githubUrl: string }): React.JSX.Element {
  const [condensed, setCondensed] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      frame.current ||= requestAnimationFrame(() => {
        frame.current = 0;
        setCondensed(window.scrollY > 24);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    const targets = SECTIONS.map(({ id }) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (targets.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.intersectionRatio);
          else visible.delete(entry.target.id);
        }
        let best: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        setActive(best);
      },
      { rootMargin: "-20% 0px -55% 0px", threshold: [0, 0.15, 0.4] },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <header className={styles.nav} data-condensed={condensed || undefined}>
      <div className={styles.navInner}>
        <Link href="/" className={styles.navBrand} aria-label="OpenZaps home">
          <OpenZapMark className={styles.navMark} />
          <span className={styles.navWordmark}>OpenZaps</span>
        </Link>
        <nav aria-label="Landing sections" className={styles.navLinks}>
          {SECTIONS.map(({ id, label }) => (
            <a
              key={id}
              href={`#${id}`}
              className={styles.navLink}
              aria-current={active === id ? "true" : undefined}
            >
              {label}
            </a>
          ))}
          <Link href="/docs" className={styles.navLink}>
            Docs
          </Link>
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={styles.navLink}
          >
            GitHub<span className={styles.navExt}>↗</span>
          </a>
        </nav>
        <Link href="/zap" className={styles.navCta} data-magnetic>
          <span>Launch App</span>
        </Link>
      </div>
    </header>
  );
}
