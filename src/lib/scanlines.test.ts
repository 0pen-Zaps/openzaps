import { describe, expect, it } from "vitest";
import { BOLT, BOLT_BOX, scanlines, type Point } from "./scanlines";

/** Unit square, wound clockwise. */
const SQUARE: readonly Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("scanlines", () => {
  it("centres rows in their bands rather than flushing them to the edges", () => {
    const { pitch, spans } = scanlines(SQUARE, 5);
    expect(pitch).toBe(2);
    expect(spans.map((s) => s.y)).toEqual([1, 3, 5, 7, 9]);
  });

  it("spans the full width of a rectangle at every row", () => {
    const { spans } = scanlines(SQUARE, 4);
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      expect(span.x1).toBe(0);
      expect(span.x2).toBe(10);
    }
  });

  it("returns one segment per row for the bolt, at every row count", () => {
    // The bolt is notched but solid: no row should ever enter and leave it more
    // than once. More than one segment on a row means vertex crossings are
    // being double-counted and the even-odd pairing has gone inside out.
    for (const count of [7, 12, 18, 24, 26, 33, 48]) {
      const { spans } = scanlines(BOLT, count);
      expect(spans).toHaveLength(count);
      expect(new Set(spans.map((s) => s.i)).size).toBe(count);
    }
  });

  it("keeps every bolt segment inside the drawing box and pointing rightwards", () => {
    const { spans } = scanlines(BOLT, 40);
    for (const span of spans) {
      expect(span.x2).toBeGreaterThan(span.x1);
      expect(span.x1).toBeGreaterThanOrEqual(0);
      expect(span.x2).toBeLessThanOrEqual(BOLT_BOX.w);
      expect(span.y).toBeGreaterThan(0);
      expect(span.y).toBeLessThan(BOLT_BOX.h);
    }
  });

  it("is widest at the waist where the bolt's two arms overlap", () => {
    // The look depends on the slices varying in length; if the widest row were
    // at a tip the shape would be being sliced along the wrong axis.
    const { spans } = scanlines(BOLT, 24);
    const widest = spans.reduce((a, b) => (b.x2 - b.x1 > a.x2 - a.x1 ? b : a));
    expect(widest.y / BOLT_BOX.h).toBeGreaterThan(0.35);
    expect(widest.y / BOLT_BOX.h).toBeLessThan(0.65);
  });

  it("keeps the bolt tall enough that the waist cannot dominate", () => {
    // The waist spans the whole mark. If the shape were squat those few very
    // long bars would read as a crossbar rather than as the middle of a bolt,
    // so the aspect ratio is a real constraint on the design, not a detail.
    const { spans } = scanlines(BOLT, 30);
    const widths = spans.map((s) => s.x2 - s.x1);
    const waist = Math.max(...widths);
    const wide = widths.filter((w) => w > waist * 0.8).length;
    expect(wide / widths.length).toBeLessThan(0.25);
    expect(BOLT_BOX.h / BOLT_BOX.w).toBeGreaterThan(1.3);
  });

  it("keeps the row that lands exactly on a vertex", () => {
    // A diamond sliced once: the single row sits at y=5, exactly on BOTH side
    // vertices, and is the widest row in the shape.
    //
    // This is the case that discriminates a half-open crossing test from a
    // closed one, and it has to be constructed deliberately — an earlier
    // version of this test used a triangle whose rows happened to fall at
    // y=1.5..8.5 while its vertices sat at y=1 and y=9, so it never touched a
    // vertex at all and passed under either rule.
    //
    // Under a closed `[lo, hi]` test both edges meeting at each vertex report a
    // crossing, even-odd pairs the two duplicates with each other, both pairs
    // are zero-width, and the widest row of the shape vanishes entirely.
    const diamond: readonly Point[] = [
      [5, 0],
      [10, 5],
      [5, 10],
      [0, 5],
    ];

    const { spans } = scanlines(diamond, 1);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ y: 5, x1: 0, x2: 10 });
  });

  it("never drops or doubles a row on a shape whose vertices line up with rows", () => {
    // Same diamond swept across many row counts, half of which put a row on a
    // vertex. Every count must yield exactly `count` non-degenerate rows.
    const diamond: readonly Point[] = [
      [5, 0],
      [10, 5],
      [5, 10],
      [0, 5],
    ];

    for (let count = 1; count <= 60; count += 1) {
      const { spans } = scanlines(diamond, count);
      expect(spans, `count=${count}`).toHaveLength(count);
      expect(spans.every((s) => s.x2 > s.x1), `count=${count}`).toBe(true);
    }
  });

  it("degenerates safely", () => {
    expect(scanlines(SQUARE, 0).spans).toEqual([]);
    expect(scanlines([[0, 0]], 5).spans).toEqual([]);
  });
});
