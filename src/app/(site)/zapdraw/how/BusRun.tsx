"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { DEMO, tokens } from "./scenario";
import { CUT, HEAD_X, SERVED_PCT, STARTS, cameraVw, clamp01, frameFor } from "./run-math";
import s from "./busrun.module.css";

/**
 * THE RUN — one round of ZapDraw, travelled rather than stepped through.
 *
 * A pinned camera moves rightward along the round's capacity, drawn as one rail
 * one-and-a-half screens long. Paid claims snap solid behind a fixed head line;
 * the refused claim unrolls past the end of the bus; the money it could not be
 * paid from detaches as the carry; then the camera pulls back so the whole bus
 * fits one screen, and the CTA lands.
 *
 * WHY THE MOTION IS SHAPED THIS WAY — each of these is a comprehension decision,
 * not a stylistic one, and changing any of them teaches a different game:
 *
 *   * A paid claim SNAPS solid in a single step. It never grows. A bar that grew
 *     would say the claim was paid gradually, when the rule this page exists to
 *     teach is that a claim is paid in full or not at all.
 *   * Only SERVED claims can be painted at all. The refused claim has no paint
 *     state to set, so no future bug can colour it in and imply it got the part
 *     that fitted.
 *   * The camera stops at exactly {@link SERVED_PCT}. If it advanced past the
 *     paid-to point, the framing itself would corroborate the single most
 *     dangerous misreading of the whole page.
 *   * The "asked" bracket spans the claim's WHOLE length, not just its overhang.
 *     Bracketing only the overhang would say the part that fitted was fine.
 *   * Only scaleX is ever applied to the rail, and every label counter-scales.
 *     A uniform scale would shrink bar heights, which encode nothing, and
 *     distort lengths, which encode everything.
 *
 * ACCESSIBILITY. This component is decoration over an explanation that exists
 * elsewhere: it is `aria-hidden`, holds no focusable node except the final CTA,
 * and is only mounted when motion is permitted and the viewport can hold it.
 * Everyone else — reduced motion, Calm, phones, short windows, no JS — gets the
 * stepper, which carries the identical beats. The static path is the primary
 * deliverable here, not a fallback.
 */


/**
 * The box this section actually scrolls inside.
 *
 * The app shell moved the scroll off the window and onto its own container, so
 * a `window` scroll listener never fires here and the traverse would sit frozen
 * on beat one. Returns null when the page itself is the scroller, which is
 * still the case outside the shell.
 */
function scrollportOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

type Beat = { readonly cap: string; readonly sub: React.ReactNode };

const BEATS: readonly Beat[] = [
  { cap: "One bus.", sub: <>Everything this round can pay: <strong>{tokens(DEMO.capacity)}</strong>.</> },
  { cap: "Claims are paid smallest first.", sub: "Each one in full, the moment the bus reaches it." },
  {
    cap: "Three are paid.",
    sub: (
      <>
        {DEMO.rows.filter((r) => r.served).map((r) => tokens(r.paid)).join(" · ")} —{" "}
        <strong>{tokens(DEMO.served)}</strong> delivered.
      </>
    ),
  },
  {
    cap: "The fourth asks for more than is left.",
    sub: CUT ? (
      <>
        It wants <strong>{tokens(CUT.wants)}</strong>. The bus has <strong>{tokens(DEMO.carry)}</strong>.
      </>
    ) : null,
  },
  { cap: "So it is paid nothing.", sub: "Not trimmed, not part-paid. It never boards." },
  {
    cap: "The money it could not take stays.",
    sub: <>
      <strong>{tokens(DEMO.carry)}</strong> charges the next round.
    </>,
  },
  { cap: "That was one round.", sub: "Claim small and you are almost certainly paid. Claim big and you might not be." },
];


export function BusRun(): React.JSX.Element | null {
  const sectionRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState(0);

  /**
   * Writes the frame. Everything animated is a CSS custom property on one of two
   * elements, so a frame costs two style writes rather than a React render — and
   * the only React state is the beat index, set from inside a rAF callback and
   * diffed, which keeps it clear of `react-hooks/set-state-in-effect`.
   */
  const paint = useCallback((p: number): void => {
    const rail = railRef.current;
    const stage = stageRef.current;
    if (!rail || !stage) return;

    // Every derived value comes from `frameFor`, which is unit-tested against
    // the rules the picture is asserting — see run-math.test.ts.
    const f = frameFor(p);

    rail.style.setProperty("--cam", `${cameraVw(f)}vw`);
    rail.style.setProperty("--squeeze", f.squeeze.toFixed(4));

    for (const row of DEMO.rows) {
      if (!row.served) continue;
      const node = rail.querySelector<HTMLElement>(`[data-seg="${row.label}"]`);
      if (!node) continue;
      const paid = f.paid.includes(row.label) ? "true" : "false";
      // Diffed: a dataset write every frame would invalidate style for the
      // subtree and undo the point of throttling to one frame.
      if (node.dataset.paid !== paid) node.dataset.paid = paid;
    }

    stage.style.setProperty("--unroll", String(Math.max(f.unroll, 0.001)));
    stage.style.setProperty("--ghostOpacity", f.ghostOpacity.toFixed(3));
    stage.style.setProperty("--drop", `${f.drop * 4.5}rem`);
    stage.style.setProperty("--bracketOpacity", f.bracketOpacity.toFixed(3));
    stage.style.setProperty("--remOpacity", String(Math.max(f.bracketOpacity, f.dock)));
    stage.style.setProperty("--dock", `${f.dock * 3.2}rem`);
    stage.style.setProperty("--ctaOpacity", f.ctaOpacity.toFixed(3));
    stage.style.setProperty("--ctaEvents", f.ctaOpacity > 0.9 ? "auto" : "none");
    stage.style.setProperty("--p", p.toFixed(4));

    const next = f.beat;
    setBeat((current) => (current === next ? current : next));
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    const sticky = stickyRef.current;
    if (!section || !sticky) return;

    const port = scrollportOf(section);

    let frame = 0;
    /** The pin offset in px, cached: reading it per frame forces a style recalc. */
    let stickyTop = 0;

    // Publishes the scrollport's own height. The sticky stage must be exactly
    // as tall as the box it pins inside — a 100svh stage inside the shell's
    // shorter scrollport hides the CTA and the progress bar below the edge.
    const relayout = (): void => {
      const height = `${port ? port.clientHeight : window.innerHeight}px`;
      if (section.style.getPropertyValue("--stage-h") !== height) {
        section.style.setProperty("--stage-h", height);
      }
      stickyTop = Number.parseFloat(getComputedStyle(sticky).top) || 0;
    };

    const measure = (): void => {
      frame = 0;
      // Progress is the fraction of the section's scrollable travel consumed.
      // Derived from the sticky element's own offset so it needs no knowledge of
      // the `top` value, which is a live custom property.
      const travel = section.offsetHeight - sticky.offsetHeight;
      // Measured from the line the stage pins on, NOT from the viewport top:
      // inside the shell those are a context bar apart, and using the viewport
      // starts the traverse already part-consumed. Do NOT add `sticky.offsetTop`
      // instead: for an element that is currently stuck, that returns the
      // shifted offset rather than 0, which double-counts and runs the whole
      // traverse at roughly twice speed.
      const pin = (port ? port.getBoundingClientRect().top : 0) + stickyTop;
      const scrolled = pin - section.getBoundingClientRect().top;
      paint(travel > 0 ? clamp01(scrolled / travel) : 0);
    };
    const onScroll = (): void => {
      frame ||= requestAnimationFrame(measure);
    };
    const onResize = (): void => {
      relayout();
      onScroll();
    };

    relayout();
    measure();
    const target: EventTarget = port ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, [paint]);

  if (!CUT) return null;
  const scene = BEATS[beat] ?? BEATS[0];

  return (
    <section ref={sectionRef} className={s.section} aria-labelledby="run-title">
      <div ref={stickyRef} className={s.sticky}>
        <div className={s.head}>
          <p className={s.eyebrow}>One round</p>
          <h2 id="run-title" className={s.caption}>
            {scene?.cap}
          </h2>
          <p className={s.sub}>{scene?.sub}</p>
        </div>

        {/* Decoration over an explanation the stepper already carries in full. */}
        <div ref={stageRef} className={s.stage} aria-hidden="true">
          <div className={s.viewport}>
            <div className={s.field} />

            <div ref={railRef} className={s.rail}>
              <div className={s.bed}>
                {DEMO.rows.map((row, i) =>
                  row.served ? (
                    <div
                      key={row.label}
                      className={s.seg}
                      data-seg={row.label}
                      data-paid="false"
                      style={{ ["--x" as string]: `${STARTS[i]}%`, ["--w" as string]: `${row.widthPct}%` }}
                    >
                      <span className={s.segTag}>{tokens(row.paid)}</span>
                    </div>
                  ) : null,
                )}

                {/* What the bus could still deliver when the refused claim arrived. */}
                <div
                  className={s.remainder}
                  style={{ ["--x" as string]: `${SERVED_PCT}%`, ["--w" as string]: `${100 - SERVED_PCT}%` }}
                >
                  <span className={s.remTag}>carry {tokens(DEMO.carry)}</span>
                </div>

                {/* The refused claim, at the size it asked for. */}
                <div
                  className={s.ghost}
                  style={{ ["--x" as string]: `${SERVED_PCT}%`, ["--w" as string]: `${CUT.widthPct}%` }}
                >
                  <span className={s.ghostTag}>wants {tokens(CUT.wants)}</span>
                </div>

                {/* Both brackets share an origin so the two numbers compare directly. */}
                <div
                  className={`${s.bracket} ${s.bracketAsk}`}
                  style={{ ["--x" as string]: `${SERVED_PCT}%`, ["--w" as string]: `${CUT.widthPct}%` }}
                >
                  <span className={s.bracketTag}>asked {tokens(CUT.wants)}</span>
                </div>
                <div
                  className={`${s.bracket} ${s.bracketLeft}`}
                  style={{ ["--x" as string]: `${SERVED_PCT}%`, ["--w" as string]: `${100 - SERVED_PCT}%` }}
                >
                  <span className={s.bracketTag}>left {tokens(DEMO.carry)}</span>
                </div>

                <div className={s.endStop}>
                  <span className={s.endStopTag}>end of bus</span>
                </div>
              </div>
            </div>

            <div className={s.headLine} style={{ ["--headX" as string]: `${HEAD_X * 100}%` }}>
              <span className={s.headLabel}>paid to here</span>
            </div>
          </div>

          <div className={s.cta}>
            <Link href="/zapdraw" className={s.ctaButton}>
              Zap in to a round &rarr;
            </Link>
            <span className={s.ctaNote}>
              {tokens(DEMO.entry)} 0xZAPS a seat. Your claim stays sealed until you open it.
            </span>
          </div>

          <div className={s.progress}>
            <div className={s.progressFill} />
          </div>
        </div>
      </div>
    </section>
  );
}
