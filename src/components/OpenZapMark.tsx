import type { CSSProperties } from "react";
import { BOLT, BOLT_BOX, scanlines } from "@/lib/scanlines";

/**
 * The OpenZaps mark: a lightning bolt with no fill, drawn as a stack of
 * horizontal rules.
 *
 * The silhouette is never painted. What you see are the shape's own
 * cross-sections — each rule exactly as long as the bolt is wide at that
 * height — which is what lets the mark hold together at favicon size and gives
 * it something to animate at hero size. The geometry is computed rather than
 * clipped, so there is no `<clipPath id>` to collide with the other copies of
 * the mark on the same page, and the component stays server-renderable.
 *
 * The 512×512 box is inherited from the previous mark on purpose. Every call
 * site already sizes this component through CSS that assumes a square, so
 * keeping the aspect ratio means the identity could change without touching
 * nine layouts and a favicon pipeline.
 */

/** Rules the mark is sliced into. */
const LINES = 22;

/** Bolt height inside the 512 box, leaving even margins top and bottom. */
const DRAWN_H = 404;

const SCALE = DRAWN_H / BOLT_BOX.h;
const OFFSET_X = (512 - BOLT_BOX.w * SCALE) / 2;
const OFFSET_Y = (512 - DRAWN_H) / 2;

export function OpenZapMark({ className }: { className?: string }): React.JSX.Element {
  const { pitch, spans } = scanlines(BOLT, LINES);
  const bar = pitch * 0.6;

  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" fill="#060807" />
      <g transform={`translate(${OFFSET_X} ${OFFSET_Y}) scale(${SCALE})`}>
        {spans.map((span) => (
          <rect
            key={`${span.i}-${span.x1}`}
            x={span.x1}
            y={span.y - bar / 2}
            width={span.x2 - span.x1}
            height={bar}
            rx={Math.min(0.9, bar / 3)}
            fill="#ccf83f"
            style={{ "--i": span.i } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
