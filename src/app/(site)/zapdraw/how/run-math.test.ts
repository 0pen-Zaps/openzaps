import { describe, expect, it } from "vitest";

import { DEMO } from "@/app/(site)/zapdraw/how/scenario";
import {
  BEAT,
  BUS_IN_START,
  CAMERA_END,
  CTA_START,
  CUT,
  DOCK_END,
  DROP_END,
  FORFEIT_START,
  HEAD_X,
  PAINTABLE,
  RAIL_SCREENS,
  SERVED_PCT,
  STARTS,
  beatFor,
  cameraPct,
  frameFor,
  headPct,
  screenX,
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

  it("has no bar on the rail at all for the seat that never opened", () => {
    // The strongest version of the guarantee: the forfeited seat is absent from
    // the waterfall, so it has no geometry to mis-colour and no label a paint
    // bug could reach for.
    expect(DEMO.rows.map((r) => r.label)).not.toContain(DEMO.forfeited.label);
    expect(PAINTABLE).not.toContain(DEMO.forfeited.label);
    expect(STARTS).toHaveLength(DEMO.opened);
    for (const p of SWEEP) {
      expect(frameFor(p).paid).not.toContain(DEMO.forfeited.label);
    }
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

  /**
   * The head line says "paid to here". It is drawn in screen space at HEAD_X of
   * the viewport, while the money is drawn on the rail — so the only thing that
   * makes the label true is these two agreeing, at every width and every
   * squeeze. Asserting it as an identity is what a `vw` offset could not survive:
   * that version was correct only while the stage happened to span the window,
   * and it silently stopped being correct when the app shell added a sidebar.
   */
  it("keeps the head line exactly on the point payment has reached", () => {
    // True at every frame including the pull-back, where the camera stops
    // serving the head and the head follows the money instead. This is the
    // assertion a vw offset could not survive at any width but one.
    for (const p of SWEEP) {
      const f = frameFor(p);
      expect(headPct(f) / 100).toBeCloseTo(screenX(f, f.reach), 9);
    }
  });

  it("holds the head line still for the whole travel", () => {
    // The device the composition rests on: the head does not move while claims
    // pass it. Only the closing pull-back is allowed to move it.
    for (const p of SWEEP.filter((v) => v <= DOCK_END)) {
      expect(headPct(frameFor(p))).toBeCloseTo(HEAD_X * 100, 9);
    }
  });

  it("only shows the brackets once the refused claim is fully drawn", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.bracketOpacity > 0) expect(f.unroll).toBe(1);
    }
  });

  it("hides the brackets as the refused claim leaves the lane", () => {
    const gone = frameFor(DROP_END);
    expect(gone.drop).toBe(1);
    expect(gone.bracketOpacity).toBe(0);
    expect(gone.ghostOpacity).toBe(0);
  });
});

/**
 * The two orderings that make the traverse an account of ZapDraw rather than of
 * a game where settlement and the reveal window overlap.
 */
describe("the round happens in the order the contract runs it", () => {
  it("never moves the bus while a draw is still sealed", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.reach > 0) expect(f.opened).toBe(1);
    }
  });

  it("never assembles the bus before the forfeit has been shown", () => {
    // The forfeited entry is inside the capacity the bus carries. Showing the
    // bus first would present that money as arriving from nowhere.
    expect(BUS_IN_START).toBeGreaterThan(FORFEIT_START);
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.busIn > 0) expect(f.forfeit).toBeGreaterThan(0);
    }
  });

  it("keeps every act-one value inside 0..1 and monotonic", () => {
    let last = { sealed: 0, opened: 0, forfeit: 0, busIn: 0 };
    for (const p of SWEEP) {
      const f = frameFor(p);
      for (const key of ["sealed", "opened", "forfeit", "busIn"] as const) {
        expect(f[key]).toBeGreaterThanOrEqual(0);
        expect(f[key]).toBeLessThanOrEqual(1);
        expect(f[key]).toBeGreaterThanOrEqual(last[key]);
      }
      last = { sealed: f.sealed, opened: f.opened, forfeit: f.forfeit, busIn: f.busIn };
    }
    const end = frameFor(1);
    expect(end.sealed).toBe(1);
    expect(end.opened).toBe(1);
    expect(end.forfeit).toBe(1);
    expect(end.busIn).toBe(1);
  });
});

describe("captions never announce more than the picture shows", () => {
  /** The exact bug found by hand: "Three are paid." while C was still unpaid. */
  it("only reaches the all-three-paid beat once all three are painted", () => {
    const servedCount = PAINTABLE.length;
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat >= BEAT.ALL_PAID) {
        expect(f.paid.length).toBe(servedCount);
      }
    }
  });

  it("only reaches the refusal beats after the claim has been drawn in full", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat >= BEAT.ASKS_TOO_MUCH) expect(f.unroll).toBe(1);
    }
  });

  it("does not announce the forfeit before the seat has been struck out", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat === BEAT.FORFEIT) expect(f.forfeit).toBeGreaterThan(0);
      // And by the time it claims the bus exists, the strike is complete.
      if (f.beat >= BEAT.BUS) expect(f.forfeit).toBe(1);
    }
  });

  it("does not announce the reveals before they are open", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      if (f.beat > BEAT.OPEN) expect(f.opened).toBe(1);
    }
  });

  it("advances beats monotonically", () => {
    let previous = -1;
    for (const p of SWEEP) {
      const beat = beatFor(p);
      expect(beat).toBeGreaterThanOrEqual(previous);
      previous = beat;
    }
    expect(beatFor(0)).toBe(BEAT.SIT);
    expect(beatFor(1)).toBe(BEAT.DONE);
  });
});

describe("the closing pull-back", () => {
  it("does not squeeze the rail until the story is told", () => {
    for (const p of SWEEP) {
      if (p < DOCK_END) expect(frameFor(p).squeeze).toBe(1);
    }
  });

  it("ends with the whole bus on screen", () => {
    const end = frameFor(1);
    // Squeezed by exactly the rail's overhang, so 150% of a screen becomes 100%.
    expect(end.squeeze).toBeCloseTo(1 / RAIL_SCREENS, 6);
    // Both ends of the round are inside the viewport, which is the point of the
    // pull-back and was NOT true while the camera stayed pinned to the head: the
    // first third of the bus, including two of the three paid claims, sat off the
    // left edge in the one frame that is meant to summarise the round.
    expect(screenX(end, 0)).toBeCloseTo(0, 9);
    expect(screenX(end, 100)).toBeCloseTo(1, 9);
    // The offset is a percentage of the RAIL, not of the window.
    expect(cameraPct(end)).toBeCloseTo(0, 9);
    // And the head has followed the money to where it actually stopped.
    expect(headPct(end) / 100).toBeCloseTo((SERVED_PCT / 100) * RAIL_SCREENS * end.squeeze, 9);
  });

  it("never frames the bus so payment appears to reach further than it did", () => {
    for (const p of SWEEP) {
      const f = frameFor(p);
      // The head can never be right of the end of the paid region.
      expect(headPct(f) / 100).toBeLessThanOrEqual(screenX(f, SERVED_PCT) + 1e-9);
    }
  });

  it("reveals the call to action only at the very end", () => {
    expect(frameFor(0.9).ctaOpacity).toBe(0);
    expect(frameFor(CTA_START).ctaOpacity).toBe(0);
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
