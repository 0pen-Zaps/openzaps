"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Rolls every numeric run inside a string up from zero when it scrolls into view.
 *
 * Takes the finished string rather than a number so composite stats like
 * "63 / 0" or "9 / 9" animate both halves without the caller decomposing them.
 * The initial render is the final text, so the value is correct before (and
 * without) hydration — the animation only ever replays what is already there.
 */

const NUMERIC_RUN = /\d[\d,]*(?:\.\d+)?/g;

/** Expo-out: most of the distance is covered early, then it eases to a stop. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function interpolate(text: string, progress: number): string {
  return text.replace(NUMERIC_RUN, (run) => {
    const decimals = run.includes(".") ? run.split(".")[1].length : 0;
    const target = Number(run.replace(/,/g, ""));
    if (!Number.isFinite(target)) return run;

    const current = (target * progress).toFixed(decimals);
    // Preserve the source formatting so "1,240" doesn't animate into "1240".
    return run.includes(",")
      ? Number(current).toLocaleString("en-US", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      : current;
  });
}

export function CountUp({
  value,
  duration = 1100,
  className,
}: {
  value: string;
  duration?: number;
  className?: string;
}): React.JSX.Element {
  // `null` means "not animating" and renders `value` straight through. Keeping
  // the idle case out of state is what lets the effect avoid a synchronous
  // setState — every write below happens inside an observer or rAF callback.
  const [display, setDisplay] = useState<string | null>(null);
  const [tracked, setTracked] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);
  // The roll-up from zero is an entrance flourish, so it belongs to the first
  // time this number is seen and nothing else. The dashboard re-polls onchain
  // stats every 30s and feeds the result straight back in; without this latch
  // each poll would restart the animation and a live counter would visibly
  // read 63 -> 0 -> 64, which looks like the protocol resetting.
  const played = useRef(false);

  // Adjusting state during render is the sanctioned way to react to a changed
  // prop; it re-renders before commit rather than cascading after one.
  if (tracked !== value) {
    setTracked(value);
    setDisplay(null);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    NUMERIC_RUN.lastIndex = 0; // the /g regex is stateful across .test() calls
    const hasDigits = NUMERIC_RUN.test(value);
    NUMERIC_RUN.lastIndex = 0;
    if (reduced || !hasDigits || played.current || typeof IntersectionObserver === "undefined") return;

    let frame = 0;
    let start = 0;

    const run = (): void => {
      const step = (now: number): void => {
        start ||= now;
        const progress = Math.min(1, (now - start) / duration);
        setDisplay(interpolate(value, easeOut(progress)));
        if (progress < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        played.current = true;
        setDisplay(interpolate(value, 0));
        run();
      },
      { threshold: 0.3 },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, duration]);

  return (
    <span className={className} ref={ref} style={{ fontVariantNumeric: "tabular-nums" }}>
      {display ?? value}
    </span>
  );
}
