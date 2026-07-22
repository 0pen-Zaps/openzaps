"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ZapLinesMark } from "@/components/ZapLinesMark";
import { BOLT_LINES } from "./content";
import styles from "./LinesIntro.module.css";

/** Horizontal bands the black field is torn into on the way out. */
const BANDS = 14;

/**
 * The entrance: one green rule that becomes a bolt made of green rules.
 *
 * Timing lives in CSS so the sequence still completes with the script dead —
 * see the note on `.overlay`. This component's only jobs are to drop the
 * finished node so it can never sit invisibly over the page eating clicks, and
 * to let anyone who has seen it once get out early.
 */
export function LinesIntro(): React.JSX.Element | null {
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    // No reduced-motion branch here on purpose. CSS already gives the overlay
    // `display: none` under that preference, which takes it out of hit-testing
    // as well as out of view, so there is nothing to retire early — and doing
    // it here would mean setting state synchronously in an effect body just to
    // shave a couple of seconds off the life of an inert node.
    // Must outlast the CSS: the shutter finishes at 2922ms and `retire` fires
    // at 2960ms, so unmounting at 2900ms would have pulled the node while it
    // was still animating.
    const timer = window.setTimeout(() => setDone(true), 3150);
    const bail = (): void => setSkipped(true);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") bail();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", bail, { passive: true, once: true });
    window.addEventListener("touchmove", bail, { passive: true, once: true });
    // Tabbing dismisses too. The overlay covers the page opaquely but does not
    // contain the page, so without this a keyboard user who starts tabbing
    // during the intro moves focus through controls they cannot see. Bailing on
    // the first focus event keeps focus and the visible page in agreement,
    // which `inert` on the siblings would also do but at the cost of having to
    // know and reach every sibling.
    window.addEventListener("focusin", bail, { once: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", bail);
      window.removeEventListener("touchmove", bail);
      window.removeEventListener("focusin", bail);
    };
  }, []);

  useEffect(() => {
    if (!skipped) return;
    const timer = window.setTimeout(() => setDone(true), 260);
    return () => window.clearTimeout(timer);
  }, [skipped]);

  if (done) return null;

  return (
    <div className={styles.overlay} data-skip={skipped} aria-hidden="true">
      <div className={styles.shutter}>
        {Array.from({ length: BANDS }, (_, i) => (
          <span key={i} className={styles.band} style={{ "--i": i } as CSSProperties} />
        ))}
      </div>

      <div className={styles.stage}>
        <span className={styles.seed} />
        <ZapLinesMark className={styles.bolt} lines={BOLT_LINES} weight={0.62} motion="draw" />
        <p className={styles.caption}>
          tracing <b>{BOLT_LINES} lines</b>
        </p>
      </div>

      {/* Deliberately out of the tab order. The overlay is decorative and
          aria-hidden, and a focusable control inside an aria-hidden subtree is
          a genuine ARIA violation: assistive tech is told the region does not
          exist, yet the keyboard still lands in it. Keyboard users are not
          stranded — Escape dismisses, and so does any scroll. This button is
          the pointer affordance for the same thing. */}
      <button type="button" tabIndex={-1} className={styles.skip} onClick={() => setSkipped(true)}>
        Skip
      </button>
    </div>
  );
}
