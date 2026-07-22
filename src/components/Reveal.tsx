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
 * An IntersectionObserver always delivers an initial entry for each observed
 * target. If none has arrived shortly after the first observe, the API is not
 * functioning in this environment (throttled, polyfilled badly, or a headless
 * renderer) — and content must never be the casualty of a broken animation.
 * From then on Reveal is a no-op and every element renders plainly.
 */
function abandon(): void {
  disabled = true;
  for (const entry of pending.values()) entry.reveal();
  pending.clear();
  observer?.disconnect();
  observer = null;
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
      verified = true;
      window.clearTimeout(watchdog);
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
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

  if (!verified && watchdog === undefined) {
    watchdog = window.setTimeout(() => {
      if (!verified) abandon();
    }, 1000);
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
