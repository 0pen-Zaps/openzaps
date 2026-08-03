"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Glyph } from "./Glyph";
import { OpenZapMark } from "./OpenZapMark";
import { SiteFooter } from "./SiteFooter";
import { ThemePicker } from "./ThemePicker";
import { useWalletSession } from "./WalletProvider";
import { CHAIN, TOKEN } from "@/lib/config";
import { parseDesignLibrary, readDesignLibraryRaw } from "@/lib/designs";
import { getInjectedProvider } from "@/lib/robinhood";
import { resolveZapView, type ZapView } from "@/lib/zap-view";
import styles from "./AppShell.module.css";

/**
 * Chrome for every interior page: a persistent sidebar, a context bar, and one
 * scrolling column.
 *
 * Replaces the sticky two-row top nav plus the four-tab strip that used to sit
 * inside `/zap`. The point is not tidiness — it is that every surface in the
 * product is now one click away from every other, and the `/zap` steps are
 * destinations you can navigate to rather than tabs you have to find first.
 *
 * The scroll lives on `<main>`, not on the page, so the sidebar and the context
 * bar never move. That has one consequence worth knowing: `--nav-h` — which a
 * handful of modules add to their `position: sticky` offsets — is set to 0 on
 * the scroll container, because inside it there is no longer any chrome above
 * the scrollport to clear.
 */

type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** The `/zap` view this item stands for, when it is one of the five. */
  view?: ZapView;
  chip?: string;
};

type NavGroup = { label: string; items: readonly NavItem[] };

const GROUPS: readonly NavGroup[] = [
  {
    label: "Make",
    items: [
      { href: "/zap?view=start", label: "Start", icon: "plusCircle", view: "start" },
      { href: "/zap?view=design", label: "Compose", icon: "route", view: "design" },
      { href: "/zap?view=sign", label: "Zap now", icon: "boltFill", view: "sign" },
      { href: "/zap?view=automate", label: "Automate", icon: "repeat", view: "automate" },
      { href: "/zap?view=connect", label: "Connect", icon: "plug", view: "connect" },
    ],
  },
  {
    label: "Build with us",
    items: [
      {
        href: "/agent-kit",
        label: "Agent Kit",
        icon: "plug",
        chip: "npm",
      },
      {
        href: "/request-a-zap",
        label: "Request a Zap",
        icon: "sparkle",
        chip: "free",
      },
    ],
  },
  {
    label: "Practice",
    items: [
      {
        href: "/virtual-trading",
        label: "Virtual Trading",
        icon: "bars",
        chip: "no wallet",
      },
    ],
  },
  {
    label: "Watch",
    items: [
      { href: "/profile", label: "My zaps", icon: "wallet" },
      { href: "/rewards", label: "Fee rewards", icon: "harvest" },
      { href: "/feeshare", label: "Fee wrappers", icon: "wrap", chip: "soon" },
      { href: "/explore", label: "Explore", icon: "pulse" },
      { href: "/pot", label: "Pot", icon: "pot" },
    ],
  },
  {
    label: "Learn",
    items: [
      { href: "/learn", label: "Updates", icon: "bookmark" },
      { href: "/docs", label: "Docs", icon: "book" },
      { href: "/evals", label: "Evals", icon: "pulse" },
      { href: "/roadmap", label: "Roadmap", icon: "route" },
      { href: "/token", label: TOKEN.symbol, icon: "tokenMark" },
    ],
  },
];

/**
 * Is this the five-view zap surface?
 *
 * Exact equality, never a prefix test: the zap surface is a single route that
 * carries its view in the query string, so equality is the whole test.
 */
function isZapSurface(pathname: string): boolean {
  return pathname === "/zap";
}

/**
 * Content measures, per the design. Long-form reference surfaces are narrower
 * because a 1180px measure of 16px prose is about 130 characters a line. The
 * roadmap owns its own readable prose measures inside a wider systems grid.
 *
 * Derived from the pathname ALONE, deliberately. Compose also wants a wider
 * measure, and it is the one case that depends on `?view=`, which would mean
 * reading search params here — and a Suspense boundary around the content
 * wrapper whose fallback also renders `children` mounts every screen twice:
 * two `<main id="main">`, two sets of mount effects, two RPC polls. Compose
 * opts in from CSS instead, via `:has([data-screen-label="Compose"])`.
 */
function measureFor(pathname: string): "read" | "default" {
  if (
    pathname.startsWith("/docs")
    || pathname.startsWith("/evals")
    || pathname.startsWith("/token")
    || pathname.startsWith("/legal")
  ) return "read";
  return "default";
}

/** The screen a URL is on, as the context bar and the sidebar both name it. */
function screenFor(pathname: string, view: ZapView | null): { group: string; label: string } {
  for (const group of GROUPS) {
    for (const item of group.items) {
      if (item.view) {
        if (isZapSurface(pathname) && item.view === view) return { group: group.label, label: item.label };
        continue;
      }
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        return { group: group.label, label: item.label };
      }
    }
  }
  if (pathname.startsWith("/roadmap")) return { group: "Learn", label: "Roadmap" };
  if (pathname.startsWith("/legal")) return { group: "Learn", label: "Risk disclosures" };
  if (pathname.startsWith("/solderworks")) return { group: "Learn", label: "Solderworks" };
  return { group: "OpenZaps", label: "App" };
}

export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPath, setDrawerPath] = useState(pathname);

  // Any navigation closes the drawer. Without this, tapping a sidebar link on a
  // phone routes correctly and then leaves the sheet sitting over the result.
  //
  // Adjusted during render rather than in an effect: React restarts the render
  // immediately with the new state and never commits the intermediate frame, so
  // the sheet does not paint open-over-the-new-page for one tick the way an
  // effect-based reset would.
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // The sidebar is a persistent rail on desktop and an off-canvas drawer on
  // mobile. Only in drawer mode do we manage focus and inert the background.
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [isDrawerMode, setIsDrawerMode] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = (): void => setIsDrawerMode(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // When the drawer opens on mobile, move focus into the sheet and trap Tab
  // inside it; on close, restore focus to the toggle. The background column is
  // marked inert (in the JSX) so the scrim can't be tabbed past regardless.
  //
  // Focus is moved on the actual open/close TRANSITION, tracked with a ref, not
  // in the effect cleanup — a cleanup that refocused the toggle would steal the
  // move-in whenever the effect re-ran for any reason.
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (!isDrawerMode) {
      drawerWasOpen.current = drawerOpen;
      return;
    }
    const sidebar = sidebarRef.current;
    const focusables = (): HTMLElement[] =>
      sidebar
        ? Array.from(
            sidebar.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    if (drawerOpen && !drawerWasOpen.current) {
      focusables()[0]?.focus();
    } else if (!drawerOpen && drawerWasOpen.current) {
      drawerToggleRef.current?.focus();
    }
    drawerWasOpen.current = drawerOpen;
    if (!drawerOpen || !sidebar) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    sidebar.addEventListener("keydown", onKeyDown);
    return () => sidebar.removeEventListener("keydown", onKeyDown);
  }, [isDrawerMode, drawerOpen]);

  /**
   * `N` starts a new zap.
   *
   * The design called for ⌘N. Browsers reserve it for a new window and will not
   * let a page have it, so advertising ⌘N would print a hint for a shortcut
   * that does nothing. A bare letter is the convention for app-level jumps and
   * it actually fires — guarded, obviously, so typing "n" into the amount field
   * does not navigate away mid-zap.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "n" && event.key !== "N") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      router.push("/zap?view=start");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <div className={styles.root} data-drawer={drawerOpen || undefined}>
      <button
        type="button"
        ref={drawerToggleRef}
        className={styles.drawerToggle}
        aria-expanded={drawerOpen}
        aria-controls="app-sidebar"
        onClick={() => setDrawerOpen((open) => !open)}
      >
        <Glyph name={drawerOpen ? "close" : "menu"} className={styles.drawerToggleIcon} />
        <span className="srOnly">{drawerOpen ? "Close navigation" : "Open navigation"}</span>
      </button>

      {drawerOpen ? (
        <div className={styles.drawerScrim} onClick={() => setDrawerOpen(false)} aria-hidden />
      ) : null}

      <aside
        id="app-sidebar"
        ref={sidebarRef}
        className={styles.sidebar}
        inert={isDrawerMode && !drawerOpen}
      >
        <Link href="/" className={styles.brand}>
          <span className={styles.brandTile}>
            <OpenZapMark className={styles.brandMark} />
          </span>
          <span className={styles.brandText}>
            <strong>OpenZaps</strong>
            <span>{CHAIN.name.toUpperCase()}</span>
          </span>
        </Link>

        <Link href="/zap?view=start" className={styles.newZap}>
          <Glyph name="boltFill" className={styles.newZapBolt} />
          New zap
          <span className={styles.newZapHint} aria-hidden>
            N
          </span>
        </Link>

        <Suspense fallback={<SidebarNav view={null} />}>
          <SidebarNavLive />
        </Suspense>

        <RecentZaps />

        <div className={styles.sidebarFoot}>
          <ThemePicker />
          <WalletChip />
        </div>
      </aside>

      <div className={styles.column} inert={isDrawerMode && drawerOpen}>
        <Suspense fallback={<ContextBar pathname={pathname} view={null} />}>
          <ContextBarLive pathname={pathname} />
        </Suspense>

        {/* A div, not a <main>. Every page under this layout already renders
            its own `<main id="main">` — the skip link points at it — and a
            second one here would nest two main landmarks inside each other,
            which is both invalid and the kind of thing only a screen reader
            user finds out about. */}
        <div id="zapscroll" className={styles.scroll}>
          <div className={styles.content} data-measure={measureFor(pathname)}>
            {children}
          </div>
          {/* Kept, and kept inside the scroll. The redesign replaces the footer
              as navigation — the sidebar does that job now — but the footer is
              also where the risk disclosures, the "onchain actions are
              irreversible" line and the links to /legal and /roadmap live.
              Those are not chrome, and the handoff leaves their home as an
              open question (§11.4) rather than deleting them. */}
          <div className={styles.footer}>
            <SiteFooter />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sidebar navigation ───────────────────────────────────────────────────
   Split in two so `useSearchParams` sits behind a Suspense boundary. Calling it
   unguarded in a layout opts every page underneath out of static rendering —
   which for this app means the docs, token and explore pages stop being
   prerendered, and their SEO with them. The fallback renders the same nav with
   the `?view=` distinction missing, so the boundary costs a highlight, never a
   layout shift. */

function SidebarNavLive(): React.JSX.Element {
  const params = useSearchParams();
  const pathname = usePathname();
  const view = isZapSurface(pathname) ? resolveZapView(new URLSearchParams(params.toString())) : null;
  return <SidebarNav view={view} />;
}

function SidebarNav({ view }: { view: ZapView | null }): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Primary">
      {GROUPS.map((group) => (
        <div className={styles.group} key={group.label}>
          <span className={styles.groupLabel}>{group.label}</span>
          {group.items.map((item) => {
            const active = item.view
              ? isZapSurface(pathname) && item.view === view
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const analytics = item.href === "/request-a-zap"
              ? {
                  event: "request_zap_clicked",
                  cta: "request_zap",
                }
              : item.href === "/agent-kit"
                ? {
                    event: "builder_cta_clicked",
                    cta: "agent_kit",
                  }
                : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navItem}
                data-active={active || undefined}
                data-analytics-event={analytics?.event}
                data-analytics-cta={analytics?.cta}
                data-analytics-content={analytics ? "app_nav" : undefined}
                aria-current={active ? "page" : undefined}
              >
                <Glyph name={item.icon} className={styles.navIcon} />
                {item.label}
                {item.chip ? <span className={styles.navChip}>{item.chip}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/* ── Pick up again ────────────────────────────────────────────────────────
   The friction the redesign exists to fix: the old launcher offered four ways
   to start a zap and no way to repeat one. These are the design library's own
   saved records — the same ones the composer writes — so the rail is real
   without any new storage, and it reads empty rather than fabricating rows. */

/**
 * Subscribe to the design library as what it is: an external store.
 *
 * The snapshot is the raw JSON string rather than the parsed array, because
 * `useSyncExternalStore` compares snapshots by identity — returning a freshly
 * parsed array every render would loop forever. The server snapshot is null,
 * which is also the honest answer: there is no library until there is a
 * browser. Saving a design in a second tab updates this rail for free.
 */
function subscribeToDesigns(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

const NO_LIBRARY = (): string | null => null;

function RecentZaps(): React.JSX.Element {
  const raw = useSyncExternalStore(subscribeToDesigns, readDesignLibraryRaw, NO_LIBRARY);
  const recents = useMemo(() => parseDesignLibrary(raw).slice(0, 3), [raw]);

  return (
    <div className={styles.reuse}>
      <div className={styles.reuseHead}>
        <span className={styles.groupLabel}>Pick up again</span>
        {recents.length > 0 ? (
          <Link href="/zap?view=design" className={styles.reuseAll}>
            All
          </Link>
        ) : null}
      </div>
      {recents.length === 0 ? (
        <p className={styles.reuseEmpty}>Zaps you save in the composer show up here, ready to run again.</p>
      ) : (
        recents.map((design) => (
          <Link
            key={design.id}
            href={`/zap?view=design&d=${encodeURIComponent(design.token)}`}
            className={styles.reuseRow}
          >
            <strong>{design.name}</strong>
            <Glyph name="repeat" className={styles.reuseIcon} />
            <span className={styles.reuseMeta}>
              {design.blocks} {design.blocks === 1 ? "block" : "blocks"} · {relativeTime(design.updatedAt)}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ── Wallet chip ──────────────────────────────────────────────────────────
   Carries every state the old nav button carried — checking, no provider,
   disconnected, wrong chain, connected — because each of them is a different
   thing the user has to do next, and collapsing them into "Connect" is how
   someone ends up clicking a button that cannot help them. */

function WalletChip(): React.JSX.Element {
  const { account, status, providerAvailable, isRobinhoodChain, connect, switchToRobinhood } = useWalletSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      if (account && !isRobinhoodChain) await switchToRobinhood();
      else await connect();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  };

  if (account && isRobinhoodChain) {
    return (
      <Link className={styles.wallet} href="/profile" aria-label={`Open My zaps for ${account}`}>
        <span className={styles.walletAvatar} aria-hidden />
        <span className={styles.walletText}>
          <strong>{shortAddress(account)}</strong>
          <span className={styles.walletChain}>
            <i className={styles.livePip} aria-hidden />
            Chain {CHAIN.id}
          </span>
        </span>
        <Glyph name="chevronRight" className={styles.walletChevron} />
      </Link>
    );
  }

  const label = busy
    ? account
      ? "Switching…"
      : "Connecting…"
    : status === "checking"
      ? "Checking wallet…"
      : account
        ? "Wrong chain"
        : providerAvailable
          ? "Connect wallet"
          : "No wallet found";

  return (
    <>
      <button
        className={styles.wallet}
        data-network={account ? "wrong" : "disconnected"}
        data-busy={busy || undefined}
        disabled={busy || status === "checking" || !providerAvailable}
        onClick={() => void open()}
        title={error || (!providerAvailable && status !== "checking" ? "No injected EIP-1193 wallet was found." : undefined)}
        type="button"
      >
        <span className={styles.walletAvatar} data-idle aria-hidden />
        <span className={styles.walletText}>
          <strong>{label}</strong>
          <span className={styles.walletHint}>
            {account ? `Switch to chain ${CHAIN.id}` : `Needed to sign on chain ${CHAIN.id}`}
          </span>
        </span>
      </button>
      {error ? (
        <span className="srOnly" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* ── Context bar ──────────────────────────────────────────────────────────── */

function ContextBarLive({ pathname }: { pathname: string }): React.JSX.Element {
  const params = useSearchParams();
  const view = isZapSurface(pathname) ? resolveZapView(new URLSearchParams(params.toString())) : null;
  return <ContextBar pathname={pathname} view={view} />;
}

function ContextBar({ pathname, view }: { pathname: string; view: ZapView | null }): React.JSX.Element {
  const screen = screenFor(pathname, view);
  // Duplicating a feed or a document means nothing; duplicating a zap you are
  // about to sign is the single most useful thing on this bar.
  const canDuplicate = isZapSurface(pathname) && view !== null && view !== "start";

  return (
    <header className={styles.contextBar}>
      <span className={styles.crumb}>
        <span>{screen.group}</span>
        <Glyph name="chevronRight" className={styles.crumbSep} />
        <strong>{screen.label}</strong>
      </span>
      <ChainChip />
      {canDuplicate ? <DuplicateButton view={view} /> : null}
      <ShareButton />
    </header>
  );
}

/**
 * The live reading in the context bar.
 *
 * Gas is read from the connected wallet's own provider, not from a server
 * route, so there is no new RPC path to keep alive — and when there is no
 * wallet, or the read fails, the chip says what it actually knows instead of
 * printing a zero. A "0.00 gwei" here would be a claim about the chain that
 * nothing verified.
 */
function ChainChip(): React.JSX.Element {
  const { account, isRobinhoodChain } = useWalletSession();
  const [gwei, setGwei] = useState<string | null>(null);
  const live = Boolean(account) && isRobinhoodChain;
  // Derived, not cleared in the effect. A stale price from a previous
  // connection must not survive a disconnect, and gating it here is both
  // simpler and impossible to get out of step with `live`.
  const reading = live ? gwei : null;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const provider = getInjectedProvider();
        if (!provider) return;
        const raw = await provider.request({ method: "eth_gasPrice" });
        if (cancelled || typeof raw !== "string") return;
        const wei = BigInt(raw);
        setGwei((Number(wei) / 1e9).toFixed(2));
      } catch {
        // A failed read leaves the chip showing the chain without a price,
        // which is the truth: connected, gas unknown.
        if (!cancelled) setGwei(null);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live]);

  return (
    <span className={styles.chainChip} data-live={live || undefined}>
      <i className={styles.livePip} aria-hidden />
      {live ? (reading ? `live · ${reading} gwei` : "live") : `chain ${CHAIN.id}`}
    </span>
  );
}

/**
 * Re-opens the current zap's configuration as a fresh, unsigned one.
 *
 * It carries the route/amount/bps the URL already describes and drops anything
 * that identifies a specific created zap, so the console mounts clean against
 * the same design. Nothing is signed, approved or submitted by pressing it.
 */
function DuplicateButton({ view }: { view: ZapView }): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();

  const duplicate = useCallback((): void => {
    const next = new URLSearchParams(params.toString());
    next.set("view", view);
    next.delete("address");
    next.delete("src");
    router.push(`/zap?${next.toString()}`);
  }, [params, router, view]);

  return (
    <button type="button" className={styles.barButton} onClick={duplicate}>
      <Glyph name="copy" className={styles.barIcon} />
      Duplicate
    </button>
  );
}

function ShareButton(): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const share = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is refused in some contexts. Saying nothing is worse
      // than saying it did not work — the URL is still in the address bar.
      setCopied(false);
    }
  }, []);

  return (
    <button type="button" className={styles.barButton} onClick={() => void share()}>
      <Glyph name={copied ? "tick" : "share"} className={styles.barIcon} />
      {copied ? "Copied" : "Share"}
    </button>
  );
}
