import { DEMO } from "./scenario";

/**
 * The scroll→picture mapping for the ZapDraw traverse, as pure functions.
 *
 * This lives apart from `BusRun.tsx` because it is the part that can be WRONG in
 * a way a reader would believe. Every value here decides what the animation
 * asserts about the game, and a mistake produces a page that teaches a rule the
 * contract does not implement — so it is unit-tested rather than eyeballed.
 *
 * THE TRAVERSE COVERS THE WHOLE ROUND. It used to open on the bus already
 * assembled and travel straight down the waterfall, which taught the settlement
 * rule and silently skipped the two phases a player actually acts in: the sealed
 * commit, and the reveal they have to come back for. The seat that never reveals
 * forfeits its entry into the capacity everyone else is paid from — the single
 * most expensive thing about this game, and it happened on the live table's
 * first round. A traverse that omits it is not a stylised account of ZapDraw; it
 * is an account of a different game.
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
 * Phase boundaries in scroll progress, pinned to the moments the stage actually
 * changes rather than spaced evenly.
 *
 * The split between the two acts is the one number here that is a taste
 * judgement rather than a derivation: everything up to {@link BUS_IN_END} is the
 * table — pay in, seal, open, forfeit — and everything after it is the bus.
 * Moving that line changes which half of the game the page emphasises, and
 * nothing but the reader's attention depends on where it falls.
 */
export const SEAL_START = 0.05;
export const SEAL_END = 0.12;
export const OPEN_START = 0.15;
export const OPEN_END = 0.25;
export const FORFEIT_START = 0.33;
export const FORFEIT_END = 0.4;
export const BUS_IN_START = 0.42;
export const BUS_IN_END = 0.48;
/** `CAMERA_END` is shared with the captions so none can announce an unmade payment. */
export const CAMERA_START = 0.5;
export const CAMERA_END = 0.68;
const UNROLL_END = 0.755;
const BRACKETS_END = 0.8;
const DROP_START = 0.815;
/* Exported for the tests, which assert what the stage looks like AT a boundary.
   Hard-coding the number in the test means a retune moves the boundary and the
   test keeps passing while checking the wrong frame. */
export const DROP_END = 0.865;
export const DOCK_END = 0.93;
export const CTA_START = 0.94;

/**
 * Beat indices, named because both the caption table and the tests index into
 * them. A magic `beat >= 3` in a test cannot survive inserting an act; a named
 * boundary can.
 */
export const BEAT = {
  SIT: 0,
  SEAL: 1,
  /** Draws are opening. Deliberately quotes no figure: some are still sealed. */
  OPEN: 2,
  /** Every revealed draw is open, so the figures may finally be named. */
  ALL_OPEN: 3,
  FORFEIT: 4,
  BUS: 5,
  SMALLEST_FIRST: 6,
  ALL_PAID: 7,
  ASKS_TOO_MUCH: 8,
  PAID_NOTHING: 9,
  CARRY: 10,
  DONE: 11,
} as const;

export function beatFor(p: number): number {
  if (p < SEAL_START) return BEAT.SIT;
  if (p < OPEN_START) return BEAT.SEAL;
  if (p < OPEN_END) return BEAT.OPEN;
  if (p < FORFEIT_START) return BEAT.ALL_OPEN;
  if (p < BUS_IN_START) return BEAT.FORFEIT;
  if (p < CAMERA_START) return BEAT.BUS;
  if (p < CAMERA_END) return BEAT.SMALLEST_FIRST;
  if (p < UNROLL_END) return BEAT.ALL_PAID;
  if (p < DROP_START) return BEAT.ASKS_TOO_MUCH;
  if (p < DROP_END) return BEAT.PAID_NOTHING;
  if (p < DOCK_END) return BEAT.CARRY;
  return BEAT.DONE;
}

export type Frame = {
  // ------------------------------------------------------------ the table
  /** How far the seats have closed over their draws. */
  readonly sealed: number;
  /** How far the revealed draws have opened. */
  readonly opened: number;
  /** How far the seat that never reveals has been struck out. */
  readonly forfeit: number;
  /** Cross-fade between the table and the bus: 1 means the bus has the stage. */
  readonly busIn: number;

  // -------------------------------------------------------------- the bus
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
  /** How far the closing pull-back has gone from head-pinned to whole-bus. */
  readonly fit: number;
  readonly ctaOpacity: number;
  readonly beat: number;
};

/**
 * The whole picture at scroll progress `p`.
 *
 * Two orderings in here are load-bearing rather than decorative:
 *
 *   * The camera does not move until `opened` is 1. A bus that started paying
 *     while a draw was still sealed would say settlement runs before the reveal
 *     window closes, which is the opposite of what the contract does.
 *   * The bus does not appear until the forfeit has been shown, because the
 *     forfeited entry is *in* the capacity the bus carries. Assembling the bus
 *     first would present that money as the protocol's rather than as the money
 *     a player left on the table.
 *
 * The camera then stops at exactly {@link SERVED_PCT}: advancing past the
 * paid-to point would let the framing corroborate the misreading this page
 * exists to prevent — that the refused claim received the part of it that
 * fitted.
 */
export function frameFor(p: number): Frame {
  const opened = span(p, OPEN_START, OPEN_END);
  const reach = span(p, CAMERA_START, CAMERA_END) * SERVED_PCT;
  const unroll = span(p, CAMERA_END, UNROLL_END);
  const brackets = span(p, UNROLL_END, BRACKETS_END);
  const drop = span(p, DROP_START, DROP_END);
  const dock = span(p, DROP_END, DOCK_END);
  const fit = span(p, DOCK_END, 1);

  // A claim is paid only once the camera clears its FAR edge. Flipping on the
  // near edge would paint it the instant the bus touched it, which is the
  // "partial fill" reading the design is built to prevent.
  const paid = DEMO.rows
    .filter((row, i) => row.served && reach >= (STARTS[i] ?? 0) + row.widthPct - 1e-9)
    .map((row) => row.label);

  return {
    sealed: span(p, SEAL_START, SEAL_END),
    opened,
    // Starts at OPEN_END, not at FORFEIT_START — one beat BEFORE the caption
    // names it. The moment the other four are open, the fifth being still sealed
    // is a visible fact; ramping from the caption's own boundary would leave the
    // caption asserting a forfeit against an untouched seat.
    forfeit: span(p, OPEN_END, FORFEIT_END),
    busIn: span(p, BUS_IN_START, BUS_IN_END),

    reach,
    squeeze: 1 - fit * (1 - 1 / RAIL_SCREENS),
    paid,
    unroll,
    bracketOpacity: brackets * (1 - drop),
    ghostOpacity: unroll > 0 ? 1 - drop : 0,
    drop,
    dock,
    fit,
    ctaOpacity: span(p, CTA_START, 1),
    beat: beatFor(p),
  };
}

/**
 * Rail offset for the given frame, as a percentage OF THE RAIL'S OWN WIDTH.
 *
 * It used to be returned in `vw`, which was correct only while the traverse
 * spanned the whole window. The app shell put a sidebar beside it: the rail is
 * `150%` of its containing box, the box is narrower than the window, and so a
 * `vw` offset undershot — parking the "paid to here" line about 170px PAST the
 * point payment actually reached, at 1440px wide. That is the exact framing the
 * rest of this file exists to prevent, and it was invisible because nothing
 * compared the two in the box's own units.
 *
 * A percentage resolves against the element being translated, so the answer is
 * scale-free: the head line lands on the camera's reach at any viewport width
 * and any squeeze. `run-math.test.ts` pins that as an identity rather than as a
 * value.
 */
export function cameraPct(frame: Frame): number {
  // While the round is being paid, the camera is computed so the reach sits on
  // the head line: the head is the still thing and the money travels past it.
  const pinned = HEAD_X / RAIL_SCREENS - (frame.reach / 100) * frame.squeeze;
  // For the closing summary the camera stops serving the head and frames the
  // whole bus instead — offset zero, with the rail squeezed to exactly one
  // viewport, so the start of the round is on screen for the final read. The
  // head stays truthful because its position is DERIVED (see `headPct`) rather
  // than fixed, which is what lets these two framings coexist at all.
  return (pinned + (0 - pinned) * frame.fit) * 100;
}

/**
 * Where a point at `contentPct` along the rail lands on screen, in units of the
 * VIEWPORT's width — the composition of the rail's translate and its scaleX,
 * written once so the test can assert against the geometry the browser applies.
 */
export function screenX(frame: Frame, contentPct: number): number {
  return RAIL_SCREENS * ((contentPct / 100) * frame.squeeze + cameraPct(frame) / 100);
}

/**
 * Where the "paid to here" line belongs, as a percentage of the viewport.
 *
 * Derived from the reach rather than fixed at {@link HEAD_X}. A fixed head is
 * only honest while the camera is computed to serve it; deriving it means the
 * label cannot be wrong for any camera, at any width, under any squeeze — which
 * is the property the `vw` offset quietly lost.
 */
export function headPct(frame: Frame): number {
  return screenX(frame, frame.reach) * 100;
}
