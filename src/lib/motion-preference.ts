export const MOTION_STORAGE_KEY = "openzaps:motion:v1";
export const MOTION_CHANGE_EVENT = "openzaps:motionchange";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type MotionMode = "cinematic" | "calm";

export function isMotionMode(value: unknown): value is MotionMode {
  return value === "cinematic" || value === "calm";
}

export function systemPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function readStoredMotionMode(): MotionMode | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(MOTION_STORAGE_KEY);
    return isMotionMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The OS reduction is a hard accessibility floor; a saved preference cannot override it. */
export function resolveMotionMode(
  stored: MotionMode | null,
  systemReduced = systemPrefersReducedMotion(),
): MotionMode {
  if (systemReduced || stored === "calm") return "calm";
  return "cinematic";
}

export function currentMotionMode(): MotionMode {
  if (typeof document !== "undefined" && isMotionMode(document.documentElement.dataset.motion)) {
    return document.documentElement.dataset.motion;
  }
  return resolveMotionMode(readStoredMotionMode());
}

export function reducedMotionEnabled(): boolean {
  return systemPrefersReducedMotion() || currentMotionMode() === "calm";
}

function stampMotionMode(mode: MotionMode): void {
  if (typeof document !== "undefined") document.documentElement.dataset.motion = mode;
}

function announceMotionMode(mode: MotionMode): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MotionMode>(MOTION_CHANGE_EVENT, { detail: mode }));
}

export function syncMotionMode(): MotionMode {
  const mode = resolveMotionMode(readStoredMotionMode());
  stampMotionMode(mode);
  announceMotionMode(mode);
  return mode;
}

export function saveMotionMode(mode: MotionMode): MotionMode {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(MOTION_STORAGE_KEY, mode);
    } catch {
      // Hardened and embedded browsers may deny storage. The live DOM setting
      // still works for this page load, which is the useful failure mode.
    }
  }
  const effective = resolveMotionMode(mode);
  stampMotionMode(effective);
  announceMotionMode(effective);
  return effective;
}
