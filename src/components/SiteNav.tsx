"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { OpenZapMark } from "./OpenZapMark";
import { BuyButton } from "./BuyButton";
import { ScrollProgress } from "./ScrollProgress";
import { useWalletSession } from "./WalletProvider";
import { TOKEN } from "@/lib/config";
import styles from "./SiteNav.module.css";

const LINKS = [
  { href: "/zap", label: "Zap" },
  { href: "/explore", label: "Explore" },
  { href: "/profile", label: "Profile" },
  { href: "/pot", label: "Pot" },
  { href: "/zapdraw", label: "ZapDraw" },
  { href: "/docs", label: "Docs" },
  { href: "/token", label: TOKEN.symbol },
] as const;

export function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  const {
    account,
    status: walletStatus,
    providerAvailable,
    isRobinhoodChain,
    connect,
    switchToRobinhood,
  } = useWalletSession();
  const [condensed, setCondensed] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState("");
  const barRef = useRef<HTMLElement>(null);

  const openWallet = async (): Promise<void> => {
    setWalletBusy(true);
    setWalletError("");
    try {
      if (account && !isRobinhoodChain) {
        await switchToRobinhood();
      } else {
        await connect();
      }
    } catch (cause) {
      setWalletError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setWalletBusy(false);
    }
  };

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
        <div className={styles.actions}>
          {account && isRobinhoodChain ? (
            <Link className={styles.walletAccount} href="/profile" aria-label={`Open profile for ${account}`}>
              {shortAddress(account)}
            </Link>
          ) : (
            <button
              className={styles.walletButton}
              data-network={account ? "wrong" : "disconnected"}
              disabled={walletBusy || walletStatus === "checking" || !providerAvailable}
              onClick={() => void openWallet()}
              title={walletError || (!providerAvailable && walletStatus !== "checking" ? "No injected EIP-1193 wallet was found." : undefined)}
              type="button"
            >
              {walletBusy
                ? account ? "Switching…" : "Connecting…"
                : walletStatus === "checking"
                  ? "Wallet…"
                  : account
                    ? "Switch chain"
                    : providerAvailable
                      ? "Connect"
                      : "No wallet"}
            </button>
          )}
          <BuyButton className={styles.cta} destination="openzaps" />
        </div>
        {walletError ? <span className="srOnly" role="alert">{walletError}</span> : null}
      </nav>
      <ScrollProgress />
    </header>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
