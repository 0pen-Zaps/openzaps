"use client";

import { useSyncExternalStore } from "react";
import {
  MOTION_CHANGE_EVENT,
  REDUCED_MOTION_QUERY,
  reducedMotionEnabled,
} from "@/lib/motion-preference";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(MOTION_CHANGE_EVENT, onStoreChange);
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => {
    window.removeEventListener(MOTION_CHANGE_EVENT, onStoreChange);
    media.removeEventListener("change", onStoreChange);
  };
}

/**
 * Reactive accessibility gate for JS-driven motion.
 *
 * CSS reads the same `html[data-motion]` state. The server snapshot is calm so
 * hydration never starts a decorative loop before the browser preference is
 * known; the root beforeInteractive guard stamps the real mode before paint.
 */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, reducedMotionEnabled, () => true);
}
