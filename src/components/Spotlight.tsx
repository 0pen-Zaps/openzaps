"use client";

import { useEffect } from "react";

/**
 * Cursor-tracking highlight for every `.spotlight` element on the page.
 *
 * Uses one delegated pointermove listener rather than a listener per card, and
 * writes the position into `--mx`/`--my` custom properties that the `.spotlight`
 * rule in globals.css reads. Server-rendered cards therefore need no wrapper
 * component — they just carry the class. Renders nothing.
 */
export function Spotlight(): null {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Touch pointers have no hover state; tracking there just burns frames.
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    let frame = 0;
    let queued: { el: HTMLElement; x: number; y: number } | null = null;

    const flush = (): void => {
      frame = 0;
      if (!queued) return;
      queued.el.style.setProperty("--mx", `${queued.x}%`);
      queued.el.style.setProperty("--my", `${queued.y}%`);
      queued = null;
    };

    const onMove = (event: PointerEvent): void => {
      const target = (event.target as Element | null)?.closest<HTMLElement>(".spotlight");
      if (!target) return;

      const box = target.getBoundingClientRect();
      queued = {
        el: target,
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
      };
      // Coalesce to one write per frame: pointermove fires far faster than paint.
      frame ||= requestAnimationFrame(flush);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
