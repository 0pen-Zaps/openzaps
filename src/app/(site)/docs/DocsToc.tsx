"use client";

import { useEffect, useRef, useState } from "react";

import { DOC_SECTIONS } from "./sections";
import styles from "./docs.module.css";

/**
 * The page outline, with the section you are reading marked.
 *
 * Strictly progressive: the server renders every link with no active state, so
 * the outline is complete for a crawler and for a visitor with JS off, and the
 * links are plain `href` anchors — nothing here hijacks a scroll. If
 * IntersectionObserver is missing the effect returns and the rail simply never
 * highlights, which is a lost affordance rather than a lost page.
 */
export function DocsToc(): React.JSX.Element {
  const navRef = useRef<HTMLElement>(null);
  // The first section, server-side and before the first observation. At the
  // top of the article that is where the reader is, and it means the rail
  // never renders with nothing marked — including with JS off.
  const [active, setActive] = useState<string>(DOC_SECTIONS[0].id);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    // The bottom 70% of the viewport is excluded, so "current" means the
    // section whose heading has reached the top band of the screen rather than
    // whichever one happens to be tallest.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const topmost = DOC_SECTIONS.find((section) => visible.has(section.id));
        if (topmost) setActive(topmost.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );

    // Observing every section also settles the deep-link case: an observer
    // emits an initial record for each target it is given, so arriving at
    // /docs#gates marks that section without reading the hash separately.
    for (const section of DOC_SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  // On a phone the rail is a horizontal strip of chips, and the active one is
  // routinely off the left edge. Scrolled by hand rather than with
  // scrollIntoView, which would also scroll the shell's container.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !active) return;
    if (nav.scrollWidth <= nav.clientWidth) return;
    const chip = nav.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!chip) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    nav.scrollTo({
      left: Math.max(0, chip.offsetLeft - (nav.clientWidth - chip.offsetWidth) / 2),
      behavior: calm ? "auto" : "smooth",
    });
  }, [active]);

  return (
    <nav className={styles.toc} aria-label="Documentation sections" ref={navRef}>
      <span className={styles.tocLabel}>ON THIS PAGE</span>
      {DOC_SECTIONS.map((section) => {
        const on = section.id === active;
        return (
          <a
            key={section.id}
            className={on ? `${styles.tocLink} ${styles.tocOn}` : styles.tocLink}
            href={`#${section.id}`}
            aria-current={on ? "location" : undefined}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
