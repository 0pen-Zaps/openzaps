import { describe, expect, it } from "vitest";

import { EDGE_BAND_PX, EDGE_SPEED_PX, edgeScrollDelta } from "@/lib/drag";

const HEIGHT = 800;

describe("edgeScrollDelta", () => {
  it("does nothing while the pointer is clear of both edges", () => {
    expect(edgeScrollDelta(HEIGHT / 2, HEIGHT)).toBe(0);
    // Exactly on the band boundary is still clear: the band is what is inside it.
    expect(edgeScrollDelta(EDGE_BAND_PX, HEIGHT)).toBe(0);
    expect(edgeScrollDelta(HEIGHT - EDGE_BAND_PX, HEIGHT)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom", () => {
    expect(edgeScrollDelta(EDGE_BAND_PX - 1, HEIGHT)).toBeLessThan(0);
    expect(edgeScrollDelta(HEIGHT - EDGE_BAND_PX + 1, HEIGHT)).toBeGreaterThan(0);
  });

  it("ramps with depth into the band", () => {
    const graze = edgeScrollDelta(HEIGHT - EDGE_BAND_PX + 8, HEIGHT);
    const deep = edgeScrollDelta(HEIGHT - 8, HEIGHT);
    expect(graze).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(graze);
  });

  it("caps the speed, so overshooting the edge is not faster", () => {
    expect(edgeScrollDelta(HEIGHT, HEIGHT)).toBe(EDGE_SPEED_PX);
    // A pointer dragged clean off the bottom of the screen.
    expect(edgeScrollDelta(HEIGHT + 4000, HEIGHT)).toBe(EDGE_SPEED_PX);
    expect(edgeScrollDelta(-4000, HEIGHT)).toBe(-EDGE_SPEED_PX);
  });

  it("is symmetric about the middle", () => {
    for (const offset of [1, 20, 50, 95]) {
      expect(edgeScrollDelta(EDGE_BAND_PX - offset, HEIGHT)).toBe(-edgeScrollDelta(HEIGHT - EDGE_BAND_PX + offset, HEIGHT));
    }
  });

  it("stands down in a viewport too short to hold two bands", () => {
    // Otherwise every position in a short window — the middle included — reads
    // as against an edge, and the page scrolls on its own for the whole drag.
    const short = EDGE_BAND_PX * 2 - 1;
    for (const y of [0, short / 2, short]) {
      expect(edgeScrollDelta(y, short)).toBe(0);
    }
  });
});
