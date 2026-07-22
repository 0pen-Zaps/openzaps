import type { CSSProperties } from "react";
import { BOLT, BOLT_BOX, scanlines } from "@/lib/scanlines";
import styles from "./ZapLinesMark.module.css";

/**
 * The LINES mark: a lightning bolt drawn as a stack of horizontal rules.
 *
 * The silhouette is never filled. What you see is the shape's own cross-sections
 * — each line as long as the bolt is wide at that height — which is why the
 * mark still reads as a bolt at 20px and why it has something to animate at
 * 600px. `motion` decides whether those lines simply sit there (a logo), race
 * down the shape once (an entrance), or carry a pulse forever (a hero).
 *
 * A Server Component by construction: the geometry is computed rather than
 * clipped, so there is no `<clipPath id>` to collide with the other twelve
 * copies of the mark on the same page.
 */
export function ZapLinesMark({
  lines = 26,
  weight = 0.6,
  motion = "none",
  className,
  title,
}: {
  /** How many rules the bolt is sliced into. Fewer reads chunkier and bolder. */
  lines?: number;
  /** Share of each band the rule fills, 0–1. The remainder is the gap. */
  weight?: number;
  motion?: "none" | "draw" | "charge" | "both";
  className?: string;
  /** Supply only when the mark is the sole label for its link or button. */
  title?: string;
}): React.JSX.Element {
  const { pitch, spans } = scanlines(BOLT, lines);
  const bar = pitch * weight;

  return (
    <svg
      className={[styles.svg, className].filter(Boolean).join(" ")}
      viewBox={`0 0 ${BOLT_BOX.w} ${BOLT_BOX.h}`}
      data-motion={motion}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {spans.map((span) => (
        <rect
          key={`${span.i}-${span.x1}`}
          className={styles.bar}
          x={span.x1}
          y={span.y - bar / 2}
          width={span.x2 - span.x1}
          height={bar}
          // Just enough radius to take the glare off the corners without
          // rounding the stack into a row of pills.
          rx={Math.min(0.9, bar / 3)}
          style={{ "--i": span.i } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/** Mark plus wordmark, at whatever font-size the caller sets. */
export function ZapLinesLockup({
  motion = "none",
  className,
}: {
  motion?: "none" | "draw" | "charge" | "both";
  className?: string;
}): React.JSX.Element {
  return (
    <span className={[styles.lockup, className].filter(Boolean).join(" ")}>
      <ZapLinesMark className={styles.lockupMark} motion={motion} lines={16} weight={0.58} />
      <span className={styles.word}>
        open<b>zaps</b>
      </span>
    </span>
  );
}
