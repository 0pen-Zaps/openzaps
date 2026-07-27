import { DEMO } from "./scenario";

/**
 * The scroll→picture mapping for the ZapDraw traverse, as pure functions.
 *
 * This lives apart from `BusRun.tsx` because it is the part that can be WRONG in
 * a way a reader would believe. Every value here decides what the animation
 * asserts about the game, and a mistake produces a page that teaches a rule the
 * contract does not implement — so it is unit-tested rather than eyeballed.
 */

/** Where payment actually reached along the bus. Derived, never a literal. */
export const SERVED_PCT = DEMO.rows.filter((r) => r.served).reduce((sum, r) => sum + r.widthPct, 0);

/** The claim the bus could not cover, if this scenario has one. */
export const CUT = DEMO.rows.find((r) => !r.served) ?? null;

/** Cumulative start of each claim along the rail, in content percent. */
export const STARTS: readonly number[] = DEMO.rows.reduce<number[]>((acc, row, i) => {
  acc[i] = i === 0 ? 0 : (acc[i - 1] ?? 0) + (DEMO.rows[i - 1]?.widthPct ?? 0);
  return acc;
}, []);

/** Claims that can ever be painted as paid. The refused claim is NOT in here. */
export const PAINTABLE: readonly string[] = DEMO.rows.filter((r) => r.served).map((r) => r.label);

export const HEAD_X = 0.33;
export const RAIL_SCREENS = 1.5;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear 0→1 across [a,b], clamped outside it. */
export function span(p: number, a: number, b: number): number {
  return clamp01((p - a) / (b - a));
}

/**
 * Beat boundaries, pinned to the moments the stage actually changes rather than
 * spaced evenly. `CAMERA_END` is shared with the camera so a caption can never
 * announce a payment the picture has not made yet.
 */
export const CAMERA_START = 0.12;
export const CAMERA_END = 0.5;
const UNROLL_END = 0.62;
const BRACKETS_END = 0.7;
const DROP_START = 0.72;
const DROP_END = 0.82;
const DOCK_END = 0.92;

export function beatFor(p: number): number {
  if (p < CAMERA_START) return 0;
  if (p < CAMERA_END) return 1;
  if (p < UNROLL_END) return 2;
  if (p < DROP_START) return 3;
  if (p < DROP_END) return 4;
  if (p < DOCK_END) return 5;
  return 6;
}

export type Frame = {
  /** How far along the bus the camera has travelled, in content percent. */
  readonly reach: number;
  /** Horizontal squeeze applied to the rail during the closing pull-back. */
  readonly squeeze: number;
  /** Labels of the claims painted solid at this point. */
  readonly paid: readonly string[];
  readonly unroll: number;
  readonly bracketOpacity: number;
  readonly ghostOpacity: number;
  readonly drop: number;
  readonly dock: number;
  readonly ctaOpacity: number;
  readonly beat: number;
};

/**
 * The whole picture at scroll progress `p`.
 *
 * The camera stops at exactly {@link SERVED_PCT}: advancing past the paid-to
 * point would let the framing corroborate the misreading this page exists to
 * prevent — that the refused claim received the part of it that fitted.
 */
export function frameFor(p: number): Frame {
  const reach = span(p, CAMERA_START, CAMERA_END) * SERVED_PCT;
  const unroll = span(p, CAMERA_END, UNROLL_END);
  const brackets = span(p, UNROLL_END, BRACKETS_END);
  const drop = span(p, DROP_START, DROP_END);
  const dock = span(p, DROP_END, DOCK_END);

  // A claim is paid only once the camera clears its FAR edge. Flipping on the
  // near edge would paint it the instant the bus touched it, which is the
  // "partial fill" reading the design is built to prevent.
  const paid = DEMO.rows
    .filter((row, i) => row.served && reach >= (STARTS[i] ?? 0) + row.widthPct - 1e-9)
    .map((row) => row.label);

  return {
    reach,
    squeeze: 1 - span(p, DOCK_END, 1) * (1 - 1 / RAIL_SCREENS),
    paid,
    unroll,
    bracketOpacity: brackets * (1 - drop),
    ghostOpacity: unroll > 0 ? 1 - drop : 0,
    drop,
    dock,
    ctaOpacity: span(p, 0.94, 1),
    beat: beatFor(p),
  };
}

/** Rail offset in vw, for the given frame. */
export function cameraVw(frame: Frame): number {
  return (HEAD_X - (frame.reach / 100) * RAIL_SCREENS * frame.squeeze) * 100;
}
