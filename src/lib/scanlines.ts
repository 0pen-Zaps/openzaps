/**
 * Slice a closed polygon into horizontal bands.
 *
 * The LINES identity draws every shape as a stack of separate horizontal rules
 * rather than as a filled silhouette. The obvious way to get that is an SVG
 * `<clipPath>` full of stripes, but a clip path needs an `id`, and an `id` in a
 * component that renders more than once per page either collides or forces the
 * component to become a client component just to reach `useId`. Cutting the
 * shape here instead keeps the mark a plain, server-renderable component with no
 * document-global state, and hands the caller each line's true length — which is
 * what the entrance animation stretches and what the travelling charge rides
 * along.
 */

export type Point = readonly [number, number];

export type Span = {
  /**
   * Row index, 0 at the top. Animations stagger on this rather than on array
   * position so the cascade stays positional: a row that lands outside the
   * shape yields no segment and drops out of the array, and timing keyed to
   * array position would silently close the gap it left behind.
   */
  readonly i: number;
  /** Centre line of the band. Callers draw a bar of their own thickness on it. */
  readonly y: number;
  readonly x1: number;
  readonly x2: number;
};

export type Sliced = {
  /** Vertical distance between adjacent row centres, in polygon units. */
  readonly pitch: number;
  readonly spans: readonly Span[];
};

/**
 * Every x where the polygon boundary crosses the horizontal line `y`, sorted.
 *
 * Edges are treated as half-open in y — `[lo, hi)` — which is what keeps a row
 * passing exactly through a vertex from being counted twice. Without that rule
 * the bolt's two horizontal notches (whose endpoints share a y with the sloped
 * edges meeting them) return an odd number of crossings, and pairing them up
 * turns the shape inside out for that row. Purely horizontal edges are skipped
 * for the same reason: they cross nothing, they merely lie on the line.
 */
function crossings(poly: readonly Point[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if (ay === by) continue;
    const lo = Math.min(ay, by);
    const hi = Math.max(ay, by);
    if (y < lo || y >= hi) continue;
    xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
  }
  return xs.sort((a, b) => a - b);
}

/**
 * Cut `poly` into `count` evenly spaced horizontal bands.
 *
 * Rows sit at band centres, not band edges, so the first and last lines are
 * inset by half a pitch and the stack reads as centred inside the shape instead
 * of clipping flush against its extremes.
 *
 * Crossings are paired left-to-right under the even-odd rule, so a row that
 * enters and leaves the shape more than once (anything with a genuine hole or a
 * deep notch) yields several segments and all of them are returned.
 */
export function scanlines(poly: readonly Point[], count: number): Sliced {
  if (count < 1 || poly.length < 3) return { pitch: 0, spans: [] };

  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of poly) {
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }

  const pitch = (bottom - top) / count;
  const spans: Span[] = [];

  for (let i = 0; i < count; i += 1) {
    const y = top + (i + 0.5) * pitch;
    const xs = crossings(poly, y);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Zero-width slivers at a tip carry no ink but would still animate, so
      // they are dropped rather than rendered as invisible work.
      if (xs[k + 1] - xs[k] < 1e-6) continue;
      spans.push({ i, y, x1: xs[k], x2: xs[k + 1] });
    }
  }

  return { pitch, spans };
}

/** Drawing box the bolt below is expressed in. */
export const BOLT_BOX = { w: 100, h: 150 } as const;

/**
 * The OpenZaps bolt, as a closed polygon wound clockwise from its top point.
 *
 * Two things are tuned for being sliced rather than filled. It is raked much
 * further than a stock lightning glyph, because the long sloped edges are what
 * make the horizontal slices vary in length — a squarer bolt cuts into a stack
 * of near-identical bars and reads as a barcode. And it is tall for its width,
 * which holds down the share of the height taken by the waist: the band where
 * the upper and lower arms overlap is the full width of the mark, and on a
 * squat bolt those few very long bars read as a crossbar struck through a
 * narrow shape instead of as the middle of one continuous bolt.
 */
export const BOLT: readonly Point[] = [
  [64, 4],
  [24, 82],
  [50, 82],
  [42, 146],
  [78, 64],
  [52, 64],
];

/**
 * Rules the entrance bolt is sliced into. The intro counts these out loud, so
 * the number lives next to the geometry it describes rather than in the copy.
 */
export const INTRO_LINES = 32;
