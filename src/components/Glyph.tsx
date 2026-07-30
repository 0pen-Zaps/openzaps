/**
 * The app's whole icon set, as one flat file of geometry.
 *
 * Deliberately not an icon dependency: every glyph inherits `currentColor`, so
 * a block's accent or a nav item's state tints its own mark, and the set ships
 * as markup with no runtime and nothing to tree-shake.
 *
 * Drawn on a 24×24 box at stroke-width 1.5 with round caps and joins. The
 * weight came down from 1.6 with the redesign — at 16px in a sidebar row, 1.6
 * reads as slightly bolder than the 13.5px label beside it, which puts the
 * emphasis on the wrong element.
 *
 * A handful of marks are solid shapes rather than strokes (`boltFill`,
 * `dotFill`): they are listed in FILLED and render with `fill:currentColor`
 * and no stroke. The bolt exists in both forms on purpose — the builder
 * catalogue wants the outline so it sits beside the other block marks, and the
 * shell wants the solid one because there it IS the product's sign.
 */

const PATHS: Record<string, React.ReactNode> = {
  /* ── Route and protocol blocks ─────────────────────────────────────────── */
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.2" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 9a5 5 0 0 1 5-5h9" />
      <path d="M15 1.5 18.5 4 15 6.5" />
      <path d="M20 15a5 5 0 0 1-5 5H6" />
      <path d="M9 17.5 5.5 20 9 22.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.9 9.4 20 11.3l-6.1 1.9L12 19.1l-1.9-5.9L4 11.3l6.1-1.9z" />
      <path d="M18.5 16.5 19.3 18.7 21.5 19.5 19.3 20.3 18.5 22.5 17.7 20.3 15.5 19.5 17.7 18.7z" />
    </>
  ),
  swap: (
    <>
      <path d="M6 7h12" />
      <path d="M15 4 18 7 15 10" />
      <path d="M18 17H6" />
      <path d="M9 14 6 17 9 20" />
    </>
  ),
  split: (
    <>
      <path d="M4 12h5" />
      <path d="M9 12c4 0 3-6 7-6h4" />
      <path d="M9 12c4 0 3 6 7 6h4" />
      <path d="M17 3.5 20.5 6 17 8.5" />
      <path d="M17 15.5 20.5 18 17 20.5" />
    </>
  ),
  /* The composer's own mark: the split, without the arrowheads. Reads as
     "one thing becomes two" at 16px, where the arrows turn to mush. */
  route: (
    <>
      <path d="M4 12h5" />
      <path d="M9 12c4 0 3-6 7-6h4" />
      <path d="M9 12c4 0 3 6 7 6h4" />
    </>
  ),
  bridge: (
    <>
      <path d="M3 16V9" />
      <path d="M21 16V9" />
      <path d="M3 12a9 5 0 0 1 18 0" />
      <path d="M8 12.6V16M12 11.5V16M16 12.6V16" />
    </>
  ),
  vault: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 6.5v1.9M12 15.6v1.9M6.5 12h1.9M15.6 12h1.9" />
    </>
  ),
  borrow: (
    <>
      <path d="M12 3.5 21 8v3c0 5-3.8 8.5-9 9.5C6.8 19.5 3 16 3 11V8z" />
      <path d="M9 12h6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </>
  ),
  pool: (
    <>
      <circle cx="9" cy="10" r="5" />
      <circle cx="15" cy="14" r="5" />
    </>
  ),
  poolOut: (
    <>
      <circle cx="9" cy="12" r="5.5" />
      <path d="M16 12h5" />
      <path d="M18.5 9.5 21 12l-2.5 2.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  harvest: (
    <>
      <path d="M12 20V9" />
      <path d="M12 9c0-3.3 2.7-6 6-6 0 3.3-2.7 6-6 6z" />
      <path d="M12 13c0-2.8-2.2-5-5-5 0 2.8 2.2 5 5 5z" />
      <path d="M5 20h14" />
    </>
  ),
  wrap: (
    <>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
      <path d="M4 8l8 4.5L20 8" />
      <path d="M12 12.5V20.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 20 7v5.5c0 4.4-3.3 7.3-8 8.5-4.7-1.2-8-4.1-8-8.5V7z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4.2-4.6" />
      <circle cx="12" cy="17" r="1.3" />
    </>
  ),
  band: (
    <>
      <path d="M3 8h18" />
      <path d="M3 16h18" />
      <path d="M4 12.5 8 11l3.5 2.5L16 9.5 20 12" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.3l3.4 2" />
    </>
  ),
  hand: (
    <>
      <path d="M9 11V5.5a1.6 1.6 0 0 1 3.2 0V11" />
      <path d="M12.2 11V6.6a1.6 1.6 0 0 1 3.2 0V12" />
      <path d="M15.4 12V9.2a1.6 1.6 0 0 1 3.2 0V15c0 3.3-2.4 6-6 6-3.1 0-4.6-1.5-6.3-4L4 13.2a1.6 1.6 0 0 1 2.6-1.9L9 14" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 12s3.6-6 9-6c1.6 0 3 .5 4.2 1.3M21 12s-3.6 6-9 6c-1.7 0-3.2-.6-4.4-1.4" />
      <path d="M4 4l16 16" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  fuel: (
    <>
      <path d="M7 21V5.5A2.5 2.5 0 0 1 9.5 3h5A2.5 2.5 0 0 1 17 5.5V21" />
      <path d="M5 21h14M9 7h6v4H9z" />
      <path d="m17 8 2.5 2.5V17a1.5 1.5 0 0 0 3 0v-5l-2-2" />
    </>
  ),
  fee: (
    <>
      <path d="M5 19V9M12 19V5M19 19v-7" />
      <path d="M3 19h18" />
      <path d="m16.5 7 2.5-2.5L21.5 7" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4.5" />
      <path d="M12.5 12H21M17 12v3M20 12v2" />
    </>
  ),
  send: (
    <>
      <path d="M21 3.5 10.5 14" />
      <path d="M21 3.5 14.5 21l-4-7-7-4z" />
    </>
  ),
  safe: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M12 9v6M9 12h6" />
    </>
  ),
  loop: (
    <>
      <path d="M7 6h8a5 5 0 0 1 0 10H9" />
      <path d="M11.5 13 8.5 16l3 3" />
      <path d="M7 6 9.5 3.5" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6.6" rx="7.5" ry="3.1" />
      <path d="M4.5 6.6v5c0 1.7 3.4 3.1 7.5 3.1s7.5-1.4 7.5-3.1v-5" />
      <path d="M4.5 11.6v5c0 1.7 3.4 3.1 7.5 3.1s7.5-1.4 7.5-3.1v-5" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17v3.5" />
    </>
  ),

  /* ── Flow and status marks ─────────────────────────────────────────────── */
  bolt: <path d="M13 2.5 5.5 13.5h5L11 21.5 18.5 10.5h-5z" />,
  boltFill: <path d="M13 2.5 5.5 13.5h5L11 21.5 18.5 10.5h-5z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.2 12.2 2.6 2.6 5-5.4" />
    </>
  ),
  /* Bare tick, no ring — for a selected row, where the ring would read as a
     second, competing control. */
  tick: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4.2 21 19.5H3z" />
      <path d="M12 10v4.1" />
      <path d="M12 17.1v.1" />
    </>
  ),
  dotFill: <circle cx="12" cy="12" r="5" />,

  /* ── Navigation and chrome ─────────────────────────────────────────────── */
  plusCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  /* A rising bar chart — virtual trading performance and quantitative views. */
  bars: <path d="M4 18V9M9.5 18v-5M15 18v-8M20.5 18V6" />,
  /* A trace with a spike in it: live protocol activity. */
  pulse: <path d="M3 12h3.5l2-5 3.5 11 3-8 2 2H21" />,
  pot: (
    <>
      <ellipse cx="12" cy="6.6" rx="7.5" ry="3.1" />
      <path d="M4.5 6.6v10c0 1.7 3.4 3.1 7.5 3.1s7.5-1.4 7.5-3.1v-10" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2 2 0 0 1 6 3.5h13v17H6a2 2 0 0 0-2 2z" />
      <path d="M8 8h7M8 12h7" />
    </>
  ),
  /* The token: a ringed "Z"-stroke, distinct from the bolt so the nav does not
     carry the same mark twice. */
  tokenMark: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5 12 15l2.5-5.5" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronUp: <path d="M7 14l5-5 5 5" />,
  chevronDown: <path d="M7 10l5 5 5-5" />,
  arrowRight: (
    <>
      <path d="M4 12h15" />
      <path d="M13.5 6.5 19 12l-5.5 5.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14" />
    </>
  ),
  share: (
    <>
      <path d="M12 16V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 16v3.5h16V16" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    </>
  ),
  bookmark: <path d="M6 4.5h12v16l-6-4.2-6 4.2z" />,
};

/** Marks drawn as solid shapes rather than strokes. */
const FILLED = new Set(["boltFill", "dotFill"]);

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, className }: { name: string; className?: string }): React.JSX.Element {
  const filled = FILLED.has(name);
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name] ?? PATHS.safe}
    </svg>
  );
}
