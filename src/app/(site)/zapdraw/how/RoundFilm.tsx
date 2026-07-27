"use client";

import { useCallback, useEffect, useState } from "react";

import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import { DEMO, tokens } from "./scenario";
import styles from "./how.module.css";

/**
 * One round of ZapDraw, played out as eight beats.
 *
 * Every figure comes from `scenario.ts`, which runs the real `waterfall`, so the
 * animation cannot drift from the rules it is teaching.
 *
 * MOTION. Auto-play is gated on {useReducedMotionPreference}, which reads both
 * the OS setting and the site's Calm/Cinematic switch. Under Calm the film does
 * not advance on its own and the CSS transitions are already neutralised
 * globally, so the page becomes a plain stepper that shows each beat instantly —
 * the same information, none of the movement.
 */

type Scene = {
  readonly caption: string;
  readonly sub: React.ReactNode;
};

const CAP = tokens(DEMO.capacity);
const SERVED_PCT = DEMO.rows.filter((r) => r.served).reduce((sum, r) => sum + r.widthPct, 0);
const CUT = DEMO.rows.find((r) => !r.served);

/** Beat indices, named so the render conditions read as English. */
const SIT = 0;
// 1 is the "everyone pays" beat; nothing on the stage keys off it, so it has no
// constant of its own.
const BUS = 2;
const SEAL = 3;
const OPEN = 4;
const SORT = 5;
const DRAIN = 6;
const OUT = 7;

const SCENES: readonly Scene[] = [
  { caption: "Four players sit down.", sub: "Nobody knows what anybody else will do." },
  {
    caption: "Everyone pays the same.",
    sub: (
      <>
        <strong>{tokens(DEMO.entry)}</strong> each &rarr; <strong>{tokens(DEMO.fees)}</strong> in the pot.
      </>
    ),
  },
  {
    caption: "That pot is the bus.",
    sub: (
      <>
        Minus fees, it carries <strong>{CAP}</strong>. That is all there is.
      </>
    ),
  },
  { caption: "Each seals a secret claim.", sub: "A slice of the bus. Hidden until they open it." },
  {
    caption: "Open them.",
    sub: (
      <>
        {DEMO.byReveal.map((r) => `${r.draw / 100}%`).join(" · ")} — together, more bus than exists.
      </>
    ),
  },
  { caption: "Smallest first.", sub: "The bus always serves the modest before the greedy." },
  {
    caption: "The bus drains.",
    sub: (
      <>
        Three are paid in full: <strong>{tokens(DEMO.served)}</strong> gone.
      </>
    ),
  },
  {
    caption: "The last one wants too much.",
    sub: CUT ? (
      <>
        It asks <strong>{tokens(CUT.wants)}</strong>. Only <strong>{tokens(DEMO.carry)}</strong> is left, so it gets{" "}
        <strong>nothing</strong> — and the rest charges the next round.
      </>
    ) : null,
  },
];

const BEAT_MS = 2_600;

export function RoundFilm(): React.JSX.Element {
  const reduced = useReducedMotionPreference();
  const [step, setStep] = useState(SIT);
  // What the viewer asked for. Whether the film actually runs is derived below,
  // so switching to Calm mid-play stops it without an effect racing to undo
  // state the render has already used.
  const [wantsPlay, setWantsPlay] = useState(false);
  const playing = wantsPlay && !reduced;

  const last = SCENES.length - 1;
  const atEnd = step === last;

  useEffect(() => {
    if (!playing || reduced) return;
    const timer = window.setInterval(() => {
      setStep((current) => {
        if (current >= last) {
          window.clearInterval(timer);
          setWantsPlay(false);
          return current;
        }
        return current + 1;
      });
    }, BEAT_MS);
    return () => window.clearInterval(timer);
  }, [playing, reduced, last]);

  const restart = useCallback(() => {
    setStep(SIT);
    setWantsPlay(true);
  }, []);

  const scene = SCENES[step] ?? SCENES[0];

  return (
    <section className={styles.film} aria-label="How one round plays out">
      <header className={styles.head}>
        <p className={styles.step}>
          {String(step + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")}
        </p>
        {/* The caption is the narration, so it announces itself to screen readers
            as the film advances rather than changing silently. */}
        <h2 className={styles.caption} aria-live="polite">
          {scene?.caption}
        </h2>
        <p className={styles.captionSub}>{scene?.sub}</p>
      </header>

      <div className={styles.stage}>
        {/* ---------------------------------------------------------- bus */}
        <div className={styles.busWrap} data-on={step >= BUS}>
          <div className={styles.busLabel}>
            <span>The bus</span>
            <span className={styles.busTotal}>{CAP} 0xZAPS</span>
          </div>

          <div className={styles.bus}>
            <div className={styles.segments}>
              {DEMO.rows.map((row) => (
                <div
                  key={row.label}
                  className={styles.seg}
                  style={{ ["--w" as string]: `${row.widthPct}%` }}
                  // Only the draws that are actually served ever fill the bar.
                  data-fill={step >= DRAIN && row.served}
                >
                  <span className={styles.segTag}>{tokens(row.paid)}</span>
                </div>
              ))}
            </div>

            {/* The draw that does not fit, drawn to the size it asked for so it
                visibly runs off the end of the bus. */}
            {CUT ? (
              <div
                className={styles.ghost}
                data-on={step >= OUT}
                style={{ left: `${SERVED_PCT}%`, width: `${CUT.widthPct}%` }}
              >
                <span className={styles.ghostTag}>wants {tokens(CUT.wants)}</span>
              </div>
            ) : null}

            <div className={styles.endStop} data-on={step >= OUT} style={{ left: "100%" }}>
              <span className={styles.endStopTag}>bus ends</span>
            </div>
          </div>
        </div>

        {/* -------------------------------------------------------- seats */}
        <div className={styles.seats}>
          {DEMO.rows.map((row) => {
            const opened = step >= OPEN;
            const sorted = step >= SORT;
            const settled = step >= DRAIN;
            const state = settled ? (row.served ? "served" : "cut") : "open";
            return (
              <div
                key={row.label}
                className={styles.seat}
                style={{ ["--rank" as string]: sorted ? row.sortedRank : row.revealRank }}
                data-state={settled ? state : undefined}
              >
                <span className={styles.badge}>{row.label}</span>

                <span className={styles.drawBar}>
                  <span
                    className={styles.drawFill}
                    style={{ ["--w" as string]: `${row.widthPct}%` }}
                    data-on={opened}
                  />
                </span>

                <span className={styles.readout}>
                  <span className={`${styles.pct} ${opened ? "" : styles.sealed}`}>
                    {step < SEAL ? "—" : opened ? `${row.draw / 100}%` : "?"}
                  </span>
                  <span className={styles.amount}>
                    {settled ? tokens(row.paid) : opened ? tokens(row.wants) : ""}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        {/* ------------------------------------------------------ outcome */}
        <div className={styles.ledger} data-on={step >= OUT}>
          <div className={styles.cell}>
            <span className={styles.cellK}>Paid out</span>
            <span className={styles.cellV} data-tone="win">
              {tokens(DEMO.served)}
            </span>
          </div>
          <div className={styles.cell}>
            <span className={styles.cellK}>Cut</span>
            <span className={styles.cellV}>1 of {DEMO.seats}</span>
          </div>
          <div className={styles.cell}>
            <span className={styles.cellK}>Charges next round</span>
            <span className={styles.cellV}>{tokens(DEMO.carry)}</span>
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------- controls */}
      <div className={styles.controls}>
        {atEnd ? (
          <button type="button" className={`${styles.btn} ${styles.play}`} onClick={restart}>
            Replay
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.play}`}
            onClick={() => (reduced ? setStep((s) => Math.min(s + 1, last)) : setWantsPlay((p) => !p))}
          >
            {reduced ? "Next step" : playing ? "Pause" : "Play"}
          </button>
        )}
        <button
          type="button"
          className={styles.btn}
          onClick={() => {
            setWantsPlay(false);
            setStep((s) => Math.max(s - 1, 0));
          }}
          disabled={step === 0}
          aria-label="Previous step"
        >
          &larr;
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => {
            setWantsPlay(false);
            setStep((s) => Math.min(s + 1, last));
          }}
          disabled={atEnd}
          aria-label="Next step"
        >
          &rarr;
        </button>

        <div className={styles.dots}>
          {SCENES.map((s, i) => (
            <button
              key={s.caption}
              type="button"
              className={styles.dot}
              data-on={i === step}
              data-done={i < step}
              onClick={() => {
                setWantsPlay(false);
                setStep(i);
              }}
              aria-label={`Step ${i + 1}: ${s.caption}`}
              aria-current={i === step ? "step" : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
