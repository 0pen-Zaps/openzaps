"use client";

import Link from "next/link";
import { useEffect, useState, useId } from "react";

import { BlockGlyph } from "./BlockGlyph";
import { readDesignLibrary, type SavedDesign } from "@/lib/designs";
import styles from "./workspace.module.css";

/**
 * Start — the intent launcher.
 *
 * A client module, which it did not use to be: the reuse row reads the design
 * library out of localStorage, and that read has to happen in a browser. It
 * still server-renders, so `page.tsx` using this as its Suspense fallback keeps
 * doing what that comment says it does — the prerendered `/zap` shell carries
 * the h1, the four intent cards, and the reuse row's skeleton.
 */

const ROUTE = "robinhood-v4-weth-zaps";

/** How many saved designs the row shows. Three fills the grid without a scroll. */
const REUSE_LIMIT = 3;

const OPTIONS = [
  {
    // The prototype draws this one as a solid silhouette rather than a stroke —
    // `boltFill` is that same geometry, already in the set.
    glyph: "boltFill",
    label: "Zap now",
    title: "Zap in with one bounded authorization",
    detail: "Create the Zap, fund it, review the exact output floor, then sign and run it.",
    meta: "v1.1 · one-shot nonce",
    href: `/zap?view=sign&route=${ROUTE}`,
    accent: "instant",
  },
  {
    glyph: "repeat",
    label: "Recurring",
    title: "Repeat a fixed amount on schedule",
    detail: "Choose cadence, total Zaps, expiry, and slippage. Each one's floor is recomputed from live spot.",
    meta: "v3.1 · replaceable series",
    href: `/zap?view=automate&src=build&mode=recurring&route=${ROUTE}&amount=0.01&bps=100&interval=daily&runs=10`,
    accent: "recurring",
  },
  {
    glyph: "band",
    label: "Price trigger",
    title: "Fire once after a one-sided move",
    detail: "Pick the price move, the validity window, and a slippage band. The floor comes from a fresh quote at signing.",
    meta: "v3 · revocable nonce",
    href: `/zap?view=automate&src=build&mode=trigger&route=${ROUTE}&amount=0.01&bps=100&threshold=up10&days=30`,
    accent: "trigger",
  },
  {
    // `route`, not `split`: the same three strokes without the two arrowheads,
    // which is the mark the design draws for the composer.
    glyph: "route",
    label: "Compose",
    title: "Build the route and its execution policy",
    detail: "Connect the route, add gas, gas-price, and executor controls as one stack, then review the resolved bounds.",
    meta: "atomic policy stack · undone in one step",
    href: "/zap?view=design",
    accent: "compose",
  },
] as const;

/**
 * `idScope` distinguishes the two instances of this screen that coexist on /zap.
 *
 * `page.tsx` renders it as the Suspense fallback — that is what puts the h1 and
 * the intent copy into the statically prerendered HTML, since `UseSurface` reads
 * search params and bails the boundary to the client — and `UseSurface` then
 * renders it again as the default view. Both end up in the streamed markup, so
 * hardcoded ids gave two elements the same name and an `aria-labelledby` could
 * resolve to the inert copy in React's hidden holder.
 *
 * `useId()` alone does not fix it: it is derived from position in the tree, and
 * the two instances sit at equivalent positions, so React hands both the same
 * value. The fallback therefore names itself.
 */
export function ZapLauncher({ idScope }: { idScope?: string } = {}): React.JSX.Element {
  const generated = useId();
  const base = idScope ?? generated;
  const reuseId = `${base}-reuse`;
  const intentId = `${base}-intent`;

  return (
    <main className={styles.screen} id="main" data-screen-label="Start">
      <div className={styles.hero}>
        <div>
          <span className={styles.heroEyebrow}>NEW ZAP</span>
          <h1 className={styles.heroTitle}>Start with the outcome. Lock the rules after.</h1>
          <p className={styles.heroLede}>
            Choose how you want to Zap. Every path ends in a Zap contract with an immutable route,
            a wallet-owned recipient, and bounds you read before you sign.
          </p>
        </div>
        <aside className={styles.controlRoom}>
          <span className={styles.controlRoomLabel}>YOUR CONTROL ROOM</span>
          <strong className={styles.controlRoomLine}>
            History, live automations, revocations, and recoveries.
          </strong>
          <Link href="/profile" className={styles.controlRoomLink}>
            Open my zaps →
          </Link>
        </aside>
      </div>

      <section className={styles.section} aria-labelledby={reuseId}>
        <div className={styles.sectionHead}>
          <h2 id={reuseId} className={styles.sectionTitle}>
            Run one you already trust
          </h2>
          <span className={styles.sectionNote}>Saved on this device, newest first — up to three.</span>
        </div>
        <SavedDesigns />
      </section>

      <section aria-labelledby={intentId}>
        <div className={styles.sectionHead}>
          <h2 id={intentId} className={styles.sectionTitle}>
            Or start something new
          </h2>
          <span className={styles.sectionNote}>Nothing is submitted from this screen.</span>
        </div>

        <div className={styles.intentGrid}>
          {OPTIONS.map((option) => (
            <Link
              href={option.href}
              className={styles.intentCard}
              data-accent={option.accent}
              key={option.label}
            >
              <span className={styles.intentTile}>
                <BlockGlyph name={option.glyph} />
              </span>
              <div className={styles.intentCopy}>
                <span className={styles.intentEyebrow}>{option.label.toUpperCase()}</span>
                <h3 className={styles.intentTitle}>{option.title}</h3>
                <p className={styles.intentDetail}>{option.detail}</p>
                <span className={styles.intentMeta}>{option.meta}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}

/**
 * The reuse row: the design library's own saved records, newest first — the
 * same store the shell's "Pick up again" rail reads, so the two can never
 * disagree about what you have saved.
 *
 * `null` is not `[]`. Until the effect has run there is no library to speak
 * of — on the server, and for the frame before hydration, there is no
 * localStorage at all — and printing "nothing saved yet" in that gap would be
 * a claim about the user's library that nothing has checked. The skeleton is
 * what makes this component safe to server-render, not a polish detail; it is
 * also what keeps the relative timestamps out of the prerendered HTML, where
 * "2d ago" would be frozen at build time.
 *
 * There is no wrong-chain, busy, or error branch here on purpose: this reads
 * one local key and writes nothing. `readDesignLibrary` already fails soft —
 * a corrupt or unreadable library reads as empty rather than throwing.
 */
function SavedDesigns(): React.JSX.Element {
  const [library, setLibrary] = useState<SavedDesign[] | null>(null);

  useEffect(() => {
    const read = (): void => setLibrary(readDesignLibrary().slice(0, REUSE_LIMIT));
    read();
    // Saving a design in a second tab should not leave this row stale.
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  if (library === null) {
    return (
      <div className={styles.reuseGrid} aria-busy="true">
        {[0, 1, 2].map((slot) => (
          <div className={styles.reuseCard} data-skeleton="true" aria-hidden key={slot}>
            <div className={styles.reuseCopy}>
              <span className={styles.skelBar} />
              <span className={styles.skelBar} />
            </div>
            <span className={styles.skelBtn} />
          </div>
        ))}
      </div>
    );
  }

  if (library.length === 0) {
    return (
      <div className={styles.reuseGrid}>
        <p className={styles.reuseNotice} role="status">
          Nothing saved yet. Designs you save in the composer land here, ready to reopen and run.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.reuseGrid}>
      {library.map((design) => (
        <div className={styles.reuseCard} key={design.id}>
          <div className={styles.reuseCopy}>
            <strong className={styles.reuseName}>{design.name}</strong>
            <span className={styles.reuseMeta}>
              {design.blocks} {design.blocks === 1 ? "block" : "blocks"} · saved{" "}
              {relativeTime(design.updatedAt)}
            </span>
          </div>
          <Link
            href={`/zap?view=design&d=${encodeURIComponent(design.token)}`}
            className={styles.reuseAction}
            // Three identical "Open" links otherwise, which is a list of
            // unlabelled destinations to anyone reading them out of context.
            aria-label={`Open ${design.name} in the composer`}
          >
            Open
          </Link>
        </div>
      ))}
    </div>
  );
}

/** Mirrors the shell rail's own wording so the same design reads the same in both places. */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
