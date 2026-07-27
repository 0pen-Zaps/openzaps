"use client";

import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import { useWideViewport } from "@/components/useWideViewport";
import { BusRun } from "./BusRun";
import { RoundFilm } from "./RoundFilm";

/**
 * Chooses how a reader is shown the round.
 *
 * The scroll traverse is only mounted when motion is permitted AND the viewport
 * can hold a pinned stage. Everyone else gets the stepper, which walks the same
 * round under their own control.
 *
 * BOTH SNAPSHOT TO THE STEPPER ON THE SERVER — `useReducedMotionPreference`
 * returns `true` and `useWideViewport` returns `false` before hydration — so the
 * explanation is what renders first, for crawlers and for anyone whose JS never
 * arrives. The traverse is the enhancement, never the requirement.
 *
 * They are rendered as alternatives rather than both-with-CSS-hiding on purpose:
 * a pinned 340vh section that exists but is hidden still changes page height and
 * still runs its scroll listener, and duplicated content is worse for a crawler
 * than one honest copy.
 */
export function Walkthrough(): React.JSX.Element {
  const reduced = useReducedMotionPreference();
  const wide = useWideViewport();
  return reduced || !wide ? <RoundFilm /> : <BusRun />;
}
