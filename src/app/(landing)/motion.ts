"use client";

/**
 * Shared motion plumbing for the landing experience.
 *
 * One scroll listener, one pointer listener, one rAF loop — every landing
 * component subscribes to these buses instead of attaching its own handlers.
 * The loop only runs while at least one subscriber is registered, so sections
 * that unmount (or a page that is never scrolled) cost nothing.
 */

export type ScrollState = {
  /** Current scrollY in px. */
  y: number;
  /** Smoothed velocity in px/frame, signed (positive = scrolling down). */
  velocity: number;
  /** 0–1 progress through the whole document. */
  progress: number;
};

export type PointerState = {
  /** Viewport px. */
  x: number;
  y: number;
  /** Normalised to -1..1 around the viewport centre. */
  nx: number;
  ny: number;
};

export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function finePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

/**
 * 0 = keep it minimal, 1 = standard, 2 = full effects. Deliberately coarse:
 * the only decisions hanging off this are DPR caps, particle counts, and
 * whether the heaviest shader layers run at all.
 */
export function deviceQuality(): 0 | 1 | 2 {
  if (typeof window === "undefined") return 1;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (memory <= 2 || cores <= 2) return 0;
  if (memory <= 4 || cores <= 4 || !finePointer()) return 1;
  return 2;
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, lambda: number, dtMs: number): number {
  return current + (target - current) * (1 - Math.exp((-lambda * dtMs) / 1000));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type Listener<T> = (state: T) => void;

function createBus<T>(read: () => T, attach: (invalidate: () => void) => () => void) {
  const listeners = new Set<Listener<T>>();
  let detach: (() => void) | null = null;
  const state = { current: null as T | null };

  const invalidate = () => {
    state.current = read();
    for (const fn of listeners) fn(state.current);
  };

  return {
    subscribe(fn: Listener<T>): () => void {
      listeners.add(fn);
      if (listeners.size === 1) detach = attach(invalidate);
      if (state.current !== null) fn(state.current);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
    peek(): T {
      return state.current ?? read();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scroll bus: rAF loop while subscribed, velocity smoothed.           */
/* ------------------------------------------------------------------ */

let scrollVelocity = 0;
let lastScrollY = 0;

export const scrollBus = createBus<ScrollState>(
  () => {
    const y = typeof window === "undefined" ? 0 : window.scrollY;
    const doc = typeof document === "undefined" ? null : document.documentElement;
    const max = doc ? Math.max(1, doc.scrollHeight - window.innerHeight) : 1;
    return { y, velocity: scrollVelocity, progress: clamp(y / max, 0, 1) };
  },
  (invalidate) => {
    lastScrollY = window.scrollY;
    let frame = 0;
    let running = false;
    let idleFrames = 0;
    let lastTime = performance.now();
    const tick = (time: number) => {
      const dt = Math.max(1, time - lastTime);
      lastTime = time;
      const y = window.scrollY;
      const instantaneous = ((y - lastScrollY) / dt) * 16.7;
      lastScrollY = y;
      scrollVelocity = damp(scrollVelocity, instantaneous, 14, dt);
      invalidate();
      // The loop exists to decay velocity smoothly after scrolling stops.
      // Once both position and velocity have settled, park it — scroll and
      // resize events wake it back up — so an idle page runs no rAF at all.
      if (instantaneous === 0 && Math.abs(scrollVelocity) < 0.05) {
        idleFrames += 1;
        if (idleFrames > 24) {
          scrollVelocity = 0;
          running = false;
          invalidate();
          return;
        }
      } else {
        idleFrames = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (running) return;
      running = true;
      idleFrames = 0;
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wake();
    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", wake);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", wake);
    };
  },
);

/* ------------------------------------------------------------------ */
/* Pointer bus: passive pointermove, coalesced to one event per frame. */
/* ------------------------------------------------------------------ */

export const pointerBus = createBus<PointerState>(
  () => latestPointer,
  (invalidate) => {
    let frame = 0;
    let px = window.innerWidth / 2;
    let py = window.innerHeight / 2;
    const onMove = (event: PointerEvent) => {
      px = event.clientX;
      py = event.clientY;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        latestPointer.x = px;
        latestPointer.y = py;
        latestPointer.nx = (px / window.innerWidth) * 2 - 1;
        latestPointer.ny = (py / window.innerHeight) * 2 - 1;
        invalidate();
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  },
);

const latestPointer: PointerState = { x: 0, y: 0, nx: 0, ny: 0 };

/** Last known pointer position without subscribing. */
export function pointerSnapshot(): PointerState {
  return latestPointer;
}
