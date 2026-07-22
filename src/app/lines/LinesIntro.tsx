"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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
/**
 * Backstop only. Nothing normally reaches it: the overlay unmounts when its own
 * animation ends. It exists for the cases where no animation ever runs at all —
 * reduced motion and the seen-this-session guard both resolve to
 * `display: none`, and an element that is never displayed never fires
 * `animationend`. Leaving an inert hidden node in the tree forever is harmless
 * but untidy, so it gets swept.
 */
const FAILSAFE_MS = 6000;

export function LinesIntro(): React.JSX.Element | null {
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const finished = useRef(false);

  const finish = useCallback((): void => {
    finished.current = true;
    setDone(true);
  }, []);

  useEffect(() => {
    // No reduced-motion branch here on purpose. CSS already gives the overlay
    // `display: none` under that preference, which takes it out of hit-testing
    // as well as out of view, so there is nothing to retire early — and doing
    // it here would mean setting state synchronously in an effect body just to
    // shave a couple of seconds off the life of an inert node.
    const bail = (): void => {
      // Once the sequence has run its course the overlay is already gone,
      // hidden by `retire`'s forwards fill. Flipping to the skip path now would
      // swap the whole `animation` shorthand for `bail`, discarding that fill —
      // and `[data-skip] *` cancels the bands' fill too, so they snap back from
      // translateX(±104%) to covering their boxes. The finished intro would
      // reappear at full opacity and fade out a second time. Guarding here is
      // what keeps a late scroll or Escape from resurrecting it.
      if (finished.current) return;
      setSkipped(true);
    };
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

    const failsafe = window.setTimeout(finish, FAILSAFE_MS);

    return () => {
      window.clearTimeout(failsafe);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", bail);
      window.removeEventListener("touchmove", bail);
      window.removeEventListener("focusin", bail);
    };
  }, [finish]);

  if (done) return null;

  return (
    <div
      className={styles.overlay}
      data-skip={skipped}
      aria-hidden="true"
      /**
       * The overlay retires itself when its own animation ends, rather than on
       * a timer duplicating the CSS duration. Two clocks is what produced the
       * last two bugs here: a JS timeout measured from hydration racing a CSS
       * timeline measured from paint, and a `retire` delay that drifted out of
       * step with the shutter it was supposed to outlast. There is now one
       * clock, and it is the animation itself.
       *
       * Both exit paths land here — `retire` on the normal run, `bail` on a
       * skip — so both are covered by the same handler.
       */
      onAnimationEnd={(event) => {
        // animationend bubbles: the shutter bands and every rule of the bolt
        // fire it too, and all of them finish first.
        if (event.target !== event.currentTarget) return;
        finish();
      }}
    >
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
