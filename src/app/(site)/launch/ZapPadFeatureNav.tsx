"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./zappad.module.css";

const FEATURE_LINKS = [
  { href: "/launch", label: "Studio", matches: (pathname: string) => pathname === "/launch" },
  {
    href: "/launch/explore",
    label: "Explore",
    matches: (pathname: string) =>
      pathname.startsWith("/launch/explore") || pathname.startsWith("/launch/token/"),
  },
  {
    href: "/launch/portfolio",
    label: "My fee rights",
    matches: (pathname: string) => pathname.startsWith("/launch/portfolio"),
  },
] as const;

export function ZapPadFeatureNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <header className={styles.featureHeader}>
      <div className={styles.featureIdentity}>
        <div className={styles.lockup} aria-label="OpenZaps, ZapPad">
          <Link href="/">OpenZaps</Link>
          <span aria-hidden="true">/</span>
          <Link href="/launch">ZapPad</Link>
        </div>
        <span className={styles.chain}>Robinhood Chain · 4663</span>
      </div>

      <nav className={styles.featureNav} aria-label="ZapPad">
        {FEATURE_LINKS.map((item) => {
          const active = item.matches(pathname);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              data-active={active || undefined}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
