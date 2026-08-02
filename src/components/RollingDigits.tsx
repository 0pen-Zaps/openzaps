"use client";

import { useState } from "react";

import styles from "./RollingDigits.module.css";

/**
 * Odometer-style readout for ticking figures.
 *
 * The figure exists twice, with strict separation of duties. A visually
 * hidden span holds the value as one plain text run — the single source for
 * screen readers, text selection, copy, find-in-page, and any innerText
 * consumer. The visual layer is aria-hidden and unselectable, and every
 * glyph (current and outgoing) is pseudo-element content, so the animation
 * machinery contributes zero DOM text and a stale outgoing glyph can never
 * leak into a copied or searched string.
 *
 * A changed cell is re-keyed, which remounts it and restarts both pseudo
 * animations: the outgoing glyph rolls up and away while the incoming one
 * rolls up into place. The previous value is adjusted during render (the
 * CountUp pattern) — no effects, no timers of its own. With `animate` false
 * (calm motion) no cell ever carries data-prev, and the global calm rule
 * zeroes the keyframes as a second floor.
 */
export function RollingDigits({
  value,
  animate,
  className,
}: {
  value: string;
  animate: boolean;
  className?: string;
}): React.JSX.Element {
  const [previous, setPrevious] = useState(value);
  const [current, setCurrent] = useState(value);
  if (current !== value) {
    setPrevious(current);
    setCurrent(value);
  }

  const chars = Array.from(value);
  const previousChars = Array.from(previous);
  // When the string length shifts (e.g. "1h 00m 00s" → "59m 59s"), cells
  // realign by index, so the figure swaps statically instead of rolling
  // mismatched columns.
  const offset = chars.length - previousChars.length;

  return (
    <span className={className ? `${styles.digits} ${className}` : styles.digits}>
      <span className={styles.srOnly}>{value}</span>
      <span className={styles.cells} aria-hidden="true">
        {chars.map((char, index) => {
          const prevChar = offset === 0 ? previousChars[index] : undefined;
          const changed = animate && prevChar !== undefined && prevChar !== char;
          return (
            <span
              key={`${index}:${char}:${changed ? prevChar : ""}`}
              className={styles.cell}
              data-char={char}
              data-prev={changed ? prevChar : undefined}
            />
          );
        })}
      </span>
    </span>
  );
}
