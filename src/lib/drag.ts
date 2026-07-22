/**
 * Edge-scroll arithmetic for the builder's drag gesture.
 *
 * Kept out of the component because it is the one part of the gesture that can
 * be reasoned about without a pointer: given where the finger is and how tall
 * the viewport is, how fast should the page move? The rest of the drag —
 * capture, ghost, drop resolution — needs a real browser to mean anything.
 */

/** How close to a viewport edge a dragged block starts scrolling the page. */
export const EDGE_BAND_PX = 96;
/** The fastest the page may scroll, in pixels per animation frame. */
export const EDGE_SPEED_PX = 18;

/**
 * Pixels to scroll this frame for a pointer at `y` in a viewport `height` tall.
 *
 * Negative scrolls up, positive down, zero means the pointer is clear of both
 * bands. The speed ramps with depth into the band rather than switching on at
 * full rate, so grazing the edge nudges and burying the pointer in the corner
 * moves properly — a fixed rate makes the chain feel like it is fleeing the
 * cursor.
 */
export function edgeScrollDelta(y: number, height: number): number {
  // A viewport shorter than two bands would have them overlap, and every
  // position in it would be "against an edge" — including the middle, where a
  // pointer is not asking for anything. Nothing to do but leave it alone.
  if (height < EDGE_BAND_PX * 2) return 0;

  const pastTop = EDGE_BAND_PX - y;
  if (pastTop > 0) return -ramp(pastTop);

  const pastBottom = y - (height - EDGE_BAND_PX);
  if (pastBottom > 0) return ramp(pastBottom);

  return 0;
}

/** Depth into the band, as a speed — capped, so overshooting the edge is not faster. */
function ramp(depth: number): number {
  return Math.min(EDGE_SPEED_PX, (depth / EDGE_BAND_PX) * EDGE_SPEED_PX);
}
