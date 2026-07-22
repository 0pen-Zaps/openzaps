"use client";

import { useEffect, useState } from "react";
import styles from "./ScrollProgress.module.css";

/**
 * Reading-progress bar pinned under the sticky nav.
 *
 * Purely orientational, so it is `aria-hidden` — a progressbar role here would
 * add noise to screen readers without telling them anything the document
 * structure doesn't already convey.
 */
export function ScrollProgress(): React.JSX.Element {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;

    const measure = (): void => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0);
    };

    const onScroll = (): void => {
      frame ||= requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div aria-hidden className={styles.track}>
      <div className={styles.bar} style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}
