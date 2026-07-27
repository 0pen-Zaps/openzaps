import { describe, expect, it } from "vitest";

import { DEMO } from "@/app/(site)/zapdraw/how/scenario";
import {
  CAMERA_END,
  CUT,
  PAINTABLE,
  SERVED_PCT,
  STARTS,
  beatFor,
  cameraVw,
  frameFor,
} from "@/app/(site)/zapdraw/how/run-math";

/**
 * These are not rendering tests. Each one pins a claim the ANIMATION MAKES about
 * the game — the class of bug that produces a beautiful page teaching a rule the
 * contract does not implement.
 */

/** Every scroll position, finely sampled. */
const SWEEP = Array.from({ length: 401 }, (_, i) => i / 400);

describe("the picture never contradicts the rules", () => {
  it("never paints the refused claim, at any scroll position", () => {
    expect(CUT).not.toBeNull();
    for (const p of SWEEP) {
      expect(frameFor(p).paid).not.toContain(CUT?.label);
    }
    // Belt and braces: it is not even in the set the component can paint.
    expect(PAINTABLE).not.toContain(CUT?.label);
  });

  it("never pays a claim before the camera has cleared its far edge", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      for (const label of f.paid) {
        const i = DEMO.rows.findIndex((r) => r.label === label);
        const farEdge = (STARTS[i] ?? 0) + (DEMO.rows[i]?.widthPct ?? 0);
        expect(f.reach).toBeGreaterThanOrEqual(farEdge - 1e-6);
      }
    }
  });

  it("pays claims in ascending order and never un-pays one", () => {
    let previous = 0;
    for (const p of SWEEP) {
      const count = frameFor(p).paid.length;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
      // Whatever is paid is always a prefix of the sorted claim order.
      expect(frameFor(p).paid).toEqual(PAINTABLE.slice(0, count));
    }
  });

  /**
   * The camera stopping exactly at the paid-to point is the correctness
   * argument for the whole composition, not a framing preference. If it ever
   * advances past it, the frame itself says the refused claim got the part of it
   * that fitted.
   */
  it("never advances the camera past the point payment reached", () => {
    for (const p of SWEEP) {
      expect(frameFor(p).reach).toBeLessThanOrEqual(SERVED_PCT + 1e-9);
    }
    expect(frameFor(CAMERA_END).reach).toBeCloseTo(SERVED_PCT, 6);
    expect(frameFor(1).reach).toBeCloseTo(SERVED_PCT, 6);
  });

  it("only shows the brackets once the refused claim is fully drawn", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.bracketOpacity > 0) expect(f.unroll).toBe(1);
    }
  });

  it("hides the brackets as the refused claim leaves the lane", () => {
    const gone = frameFor(0.82);
    expect(gone.drop).toBe(1);
    expect(gone.bracketOpacity).toBe(0);
    expect(gone.ghostOpacity).toBe(0);
  });
});

describe("captions never announce more than the picture shows", () => {
  /** The exact bug found by hand: "Three are paid." while C was still unpaid. */
  it("only reaches the all-three-paid beat once all three are painted", () => {
    const servedCount = PAINTABLE.length;
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat >= 2) {
        expect(f.paid.length).toBe(servedCount);
      }
    }
  });

  it("only reaches the refusal beats after the claim has been drawn in full", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat >= 3) expect(f.unroll).toBe(1);
    }
  });

  it("advances beats monotonically", () => {
    let previous = -1;
    for (const p of SWEEP) {
      const beat = beatFor(p);
      expect(beat).toBeGreaterThanOrEqual(previous);
      previous = beat;
    }
    expect(beatFor(0)).toBe(0);
    expect(beatFor(1)).toBe(6);
  });
});

describe("the closing pull-back", () => {
  it("does not squeeze the rail until the story is told", () => {
    for (const p of SWEEP) {
      if (p < 0.92) expect(frameFor(p).squeeze).toBe(1);
    }
  });

  it("ends with the whole bus on screen", () => {
    // Squeezed by exactly the rail's overhang, so 150% of a screen becomes 100%.
    expect(frameFor(1).squeeze).toBeCloseTo(1 / 1.5, 6);
    // And the camera lands with the rail's origin back at the head line.
    expect(cameraVw(frameFor(1))).toBeCloseTo((0.33 - (SERVED_PCT / 100)) * 100, 6);
  });

  it("reveals the call to action only at the very end", () => {
    expect(frameFor(0.9).ctaOpacity).toBe(0);
    expect(frameFor(0.94).ctaOpacity).toBe(0);
    expect(frameFor(1).ctaOpacity).toBe(1);
  });
});

describe("derived geometry matches the scenario", () => {
  it("takes the served total and claim starts from the scenario, not literals", () => {
    expect(SERVED_PCT).toBe(65);
    expect(STARTS).toEqual([0, 10, 35, 65]);
    expect(PAINTABLE).toEqual(["A", "B", "C"]);
    expect(CUT?.label).toBe("D");
    // The refused claim genuinely overruns the end of the bus.
    expect(SERVED_PCT + (CUT?.widthPct ?? 0)).toBeGreaterThan(100);
  });
});
