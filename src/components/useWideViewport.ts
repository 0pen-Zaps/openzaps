"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the viewport can hold a pinned, scroll-driven stage.
 *
 * The server snapshot is `false` on purpose: the static path must be what is
 * rendered before hydration, so crawlers and no-JS readers get the explanation
 * rather than an empty pinned box, and the tall section never changes the page
 * height during first paint.
 *
 * The height half of the query matters as much as the width — a short landscape
 * window has room for the rail but not for the caption above it, and that is the
 * case where a pinned section traps a reader.
 */
const QUERY = "(min-width: 901px) and (min-height: 641px)";

function subscribe(onStoreChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

export function useWideViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
