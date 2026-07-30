"use client";

import { useEffect, useRef } from "react";
import { BlockGlyph, type GlyphName } from "@/app/(site)/zap/BlockGlyph";
import { ProtocolLogo, ProtocolStack } from "@/components/ProtocolLogo";
import { ZapLinesMark } from "@/components/ZapLinesMark";
import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import type { AssemblyPlan } from "./data";
import { clamp, deviceQuality } from "./motion";
import styles from "./landing.module.css";

/**
 * Four real builder blocks arrive like DeFi Lego, seat into one live route,
 * take a charge, and compress into a single bounded Zap.
 *
 * The whole loop runs from one normalized clock. React never re-renders per
 * frame; transforms and opacity are written directly to the four moving
 * elements. The server-rendered default is the completed composition, so Calm
 * mode, low-power devices, no-JS, and the first paint all retain the idea.
 */

const DURATION_MS = 8_800;

const SCATTER = [
  { x: -238, y: -168, r: -9 },
  { x: 226, y: -92, r: 7 },
  { x: -224, y: 112, r: 8 },
  { x: 214, y: 180, r: -7 },
] as const;

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clearAnimatedStyles(
  bricks: Array<HTMLDivElement | null>,
  current: HTMLSpanElement | null,
  capsule: HTMLDivElement | null,
): void {
  bricks.forEach((brick) => {
    if (!brick) return;
    brick.style.transform = "";
    brick.style.opacity = "";
  });
  if (current) {
    current.style.transform = "";
    current.style.opacity = "";
  }
  if (capsule) {
    capsule.style.transform = "";
    capsule.style.opacity = "";
  }
}

export function ZapAssembly({ plan }: { plan: AssemblyPlan }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const brickRefs = useRef<Array<HTMLDivElement | null>>([]);
  const currentRef = useRef<HTMLSpanElement>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPreference();

  useEffect(() => {
    const root = rootRef.current;
    const current = currentRef.current;
    const capsule = capsuleRef.current;
    const bricks = brickRefs.current;
    if (!root || !current || !capsule || reduced) return;

    const quality = deviceQuality();
    if (quality === 0) return;

    let frame = 0;
    let running = false;
    let completed = false;
    let inView = true;
    let introReady =
      document.documentElement.dataset.introSeen === "1" ||
      !document.querySelector("[data-bolt-intro]");
    let epoch = performance.now();

    const render = (time: number): boolean => {
      const elapsed = Math.max(0, time - epoch);
      if (quality === 1 && elapsed >= DURATION_MS) {
        completed = true;
        delete root.dataset.playing;
        delete root.dataset.charged;
        clearAnimatedStyles(bricks, current, capsule);
        return false;
      }

      const phase = (elapsed % DURATION_MS) / DURATION_MS;
      const collapse = easeInOut(clamp((phase - 0.49) / 0.14, 0, 1));
      const loopFade = 1 - easeOut(clamp((phase - 0.93) / 0.07, 0, 1));

      bricks.forEach((brick, index) => {
        if (!brick) return;
        const scatter = SCATTER[index] ?? SCATTER[SCATTER.length - 1];
        const arrive = easeOut(clamp((phase - (0.055 + index * 0.055)) / 0.19, 0, 1));
        const slotY = (index - (plan.bricks.length - 1) / 2) * 84;
        const x = scatter.x * (1 - arrive);
        const y = scatter.y * (1 - arrive) + slotY * arrive;
        const rotation = scatter.r * (1 - arrive);
        const collapseScale = 1 - collapse * 0.7;
        const scale = (0.84 + arrive * 0.16) * collapseScale;
        const opacity =
          arrive *
          (1 - easeOut(clamp((phase - 0.525) / 0.11, 0, 1))) *
          loopFade;

        brick.style.transform =
          `translate3d(${x.toFixed(1)}px, ${(y * (1 - collapse)).toFixed(1)}px, 0) ` +
          `rotate(${rotation.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        brick.style.opacity = opacity.toFixed(3);
      });

      const charge = easeInOut(clamp((phase - 0.34) / 0.17, 0, 1));
      const chargeFade =
        (1 - easeOut(clamp((phase - 0.53) / 0.08, 0, 1))) * loopFade;
      current.style.transform = `scaleY(${charge.toFixed(3)})`;
      current.style.opacity = (charge * chargeFade).toFixed(3);

      // Let the route disappear completely before the Zap replaces it. The
      // gap matters on mobile, where both states share the same compact slot.
      const bloom = easeOut(clamp((phase - 0.62) / 0.12, 0, 1));
      const capsuleOpacity = bloom * loopFade;
      capsule.style.transform =
        `translate(-50%, -50%) scale(${(0.76 + bloom * 0.24).toFixed(3)})`;
      capsule.style.opacity = capsuleOpacity.toFixed(3);
      root.dataset.charged = bloom > 0.86 ? "true" : "false";
      return true;
    };

    const loop = (time: number) => {
      if (!running) return;
      if (!render(time)) {
        running = false;
        return;
      }
      frame = requestAnimationFrame(loop);
    };

    const play = () => {
      if (running || completed || !inView || document.hidden || !introReady) return;
      running = true;
      root.dataset.playing = "true";
      epoch = performance.now();
      render(epoch);
      frame = requestAnimationFrame(loop);
    };

    const pause = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frame);
      delete root.dataset.charged;
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? false;
        if (inView) play();
        else pause();
      },
      { rootMargin: "120px", threshold: 0.02 },
    );
    observer.observe(root);

    const onVisibility = () => {
      if (document.hidden) pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let introObserver: MutationObserver | null = null;
    if (!introReady) {
      introObserver = new MutationObserver(() => {
        if (document.querySelector("[data-bolt-intro]")) return;
        introReady = true;
        introObserver?.disconnect();
        play();
      });
      introObserver.observe(document.body, { childList: true, subtree: true });
    } else {
      play();
    }

    return () => {
      pause();
      observer.disconnect();
      introObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      delete root.dataset.playing;
      delete root.dataset.charged;
      clearAnimatedStyles(bricks, current, capsule);
    };
  }, [plan.bricks.length, reduced]);

  return (
    <div
      ref={rootRef}
      className={styles.assembly}
      data-live={plan.deployable || undefined}
      aria-hidden="true"
    >
      <div className={styles.assemblyBoard}>
        <span className={`${styles.assemblyStatus} mono`}>
          <span className={styles.assemblyStatusDot} />
          {plan.deployable
            ? "live route · chain 4663"
            : "catalog route · adapter unavailable"}
        </span>

        <svg
          className={styles.assemblyCircuit}
          viewBox="0 0 640 640"
          preserveAspectRatio="none"
          fill="none"
        >
          <path d="M64 320H214M426 320H576" />
          <path d="M320 96V544" />
          <path d="M214 320L252 282M426 320L388 358" />
        </svg>

        <span ref={currentRef} className={styles.assemblyCurrent} />

        <div className={styles.assemblyStack}>
          {plan.bricks.map((brick, index) => (
            <div
              key={brick.key}
              ref={(element) => {
                brickRefs.current[index] = element;
              }}
              className={styles.assemblyBrick}
              data-kind={brick.kind}
              style={{ "--i": index } as React.CSSProperties}
            >
              <span className={styles.assemblyStuds}>
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className={styles.assemblyBrickGlyph}>
                <BlockGlyph name={brick.glyph as GlyphName} />
              </span>
              <span className={styles.assemblyBrickCopy}>
                <span className={`${styles.assemblyBrickKind} mono`}>
                  {brick.kind}
                </span>
                <strong>{brick.label}</strong>
                <small className="mono">{brick.detail}</small>
              </span>
              {brick.protocols.length > 0 ? (
                <span className={styles.assemblyBrickProtocols}>
                  <ProtocolStack
                    protocols={brick.protocols}
                    size={24}
                    decorative
                    eager
                  />
                </span>
              ) : (
                <span className={`${styles.assemblyBrickIndex} mono`}>
                  {String(index + 1).padStart(2, "0")}
                </span>
              )}
              <span className={styles.assemblySockets}>
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          ))}
        </div>

        <div ref={capsuleRef} className={styles.assemblyCapsule}>
          <span className={styles.assemblyCapsuleHalo} />
          <span className={styles.assemblyCapsuleMark}>
            <ProtocolLogo protocol="openzaps-vault" size={46} eager />
          </span>
          <span className={`${styles.assemblyCapsuleKicker} mono`}>
            {plan.bricks.length} blocks · 1 bounded Zap
          </span>
          <strong>{plan.result}</strong>
          <span className={`${styles.assemblyCapsuleMeta} mono`}>
            slippage bound · owner settled
          </span>
          <ZapLinesMark
            className={styles.assemblyCapsuleLines}
            lines={14}
            weight={0.62}
            motion="charge"
          />
        </div>

        <span className={`${styles.assemblyChip} ${styles.assemblyChipLeft} mono`}>
          interlock: typed
        </span>
        <span className={`${styles.assemblyChip} ${styles.assemblyChipRight} mono`}>
          execution: atomic
        </span>
      </div>
    </div>
  );
}
