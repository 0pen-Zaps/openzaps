"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";

/**
 * Scroll-triggered entrance that degrades to "already visible".
 *
 * The server renders the element with no `data-reveal` attribute at all, so
 * crawlers, JS-disabled browsers, and any renderer that never runs effects see
 * fully opaque content. Only after mount does the effect stamp
 * `data-reveal="hidden"` and hand the element to an observer that flips it to
 * `"shown"`. That ordering is the whole point: content visibility can never
 * depend on an animation being evaluated.
 */

type Entry = { el: Element; reveal: () => void };

let observer: IntersectionObserver | null = null;
let watchdog: number | undefined;
/** Set once the observer proves it delivers, or once it proves it doesn't. */
let verified = false;
let disabled = false;
const pending = new Map<Element, Entry>();

/**
 * Give up on scroll-reveal entirely and show everything still waiting.
 *
 * From then on Reveal is a no-op and every element renders plainly.
 */
function abandon(): void {
  disabled = true;
  for (const entry of pending.values()) entry.reveal();
  pending.clear();
  observer?.disconnect();
  observer = null;
  window.removeEventListener("scroll", markLive);
}

/**
 * Record proof that this is a live, scrolling session.
 *
 * Deliberately NOT called for a merely-delivered observer entry: an
 * IntersectionObserver emits an initial record for *every* observed target,
 * including non-intersecting ones, so treating any delivery as proof would
 * disarm the watchdog instantly and strand everything below the fold. Only an
 * element actually coming into view, or a real scroll, counts.
 */
function markLive(): void {
  if (verified) return;
  verified = true;
  window.clearTimeout(watchdog);
  watchdog = undefined;
  window.removeEventListener("scroll", markLive);
}

/**
 * One observer shared by every Reveal on the page. Each instance registering
 * its own would allocate a callback and a rect-tracking job per element; a
 * single instance batches them into one intersection pass.
 */
function watch(el: Element, reveal: () => void): () => void {
  if (disabled || typeof IntersectionObserver === "undefined") {
    reveal();
    return () => {};
  }

  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        markLive();
        pending.get(entry.target)?.reveal();
        pending.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    // Fire slightly before the element reaches the viewport edge so the
    // transition is already settling by the time it is properly on screen.
    { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
  );

  pending.set(el, { el, reveal });
  observer.observe(el);

  // Arm a wall-clock ceiling on how long anything may stay hidden. A renderer
  // that executes JS but never scrolls — an OG screenshot service, a Lighthouse
  // visual audit, a prerenderer, Google's rendered-page capture — would
  // otherwise hold every below-fold element at opacity 0 indefinitely. A real
  // visitor cancels it the moment they scroll, keeping the full effect; one who
  // never scrolls only "loses" an animation on content they cannot see anyway.
  if (!verified && watchdog === undefined) {
    window.addEventListener("scroll", markLive, { passive: true, once: true });
    watchdog = window.setTimeout(() => {
      watchdog = undefined; // cleared so a later route change can re-arm
      if (!verified) abandon();
    }, 5000);
  }

  return () => {
    pending.delete(el);
    observer?.unobserve(el);
  };
}

export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  style,
  children,
  ...rest
}: {
  /** Render as the real semantic element rather than nesting a wrapper div. */
  as?: ElementType;
  /** Stagger offset in ms, used to cascade siblings. */
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
} & Record<string, unknown>): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Already on screen on load (a deep link, a restored scroll position, or a
    // short page): show it immediately rather than hiding then re-revealing.
    // Also covers the case where reveals have been abandoned entirely.
    const box = el.getBoundingClientRect();
    if (disabled || box.top < window.innerHeight * 0.9) {
      el.dataset.reveal = "shown";
      return;
    }

    el.dataset.reveal = "hidden";
    return watch(el, () => {
      el.dataset.reveal = "shown";
    });
  }, []);

  return (
    <Tag
      ref={ref}
      className={className}
      // Merged rather than replaced: callers pass their own custom properties
      // (sheen offsets, accents) and the stagger delay must survive alongside.
      style={delay ? { ...style, ["--reveal-delay" as string]: `${delay}ms` } : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
