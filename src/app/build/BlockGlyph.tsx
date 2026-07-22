/**
 * Icon set for the lego catalog.
 *
 * Deliberately one flat file of stroke geometry rather than an icon dependency:
 * every glyph inherits `currentColor` so a block's accent tints its own mark,
 * and the whole set ships as markup with no runtime cost.
 */

const PATHS: Record<string, React.ReactNode> = {
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
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
};

export function BlockGlyph({ name, className }: { name: string; className?: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name] ?? PATHS.safe}
    </svg>
  );
}
