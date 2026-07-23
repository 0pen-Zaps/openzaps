"use client";

import { useEffect, useRef } from "react";
import { clamp, reducedMotion, scrollBus } from "./motion";
import styles from "./landing.module.css";

/**
 * The signature beat of the page: five manual DeFi actions converge, compress,
 * and become one yellow capsule as the user scrolls through a pinned stage.
 *
 * The choreography is driven by a single 0–1 progress value derived from the
 * section's position; JS writes transforms directly (no per-frame React).
 * Under reduced motion, or when the stage cannot pin (short viewports), the
 * CSS fallback renders the honest static before/after instead.
 */

const MANUAL_STEPS = [
  { title: "Approve USDG", detail: "allowance for the router" },
  { title: "Swap USDG → aeWETH", detail: "aeWETH/USDG pool · fee 450" },
  { title: "Approve aeWETH", detail: "second allowance" },
  { title: "Swap aeWETH → 0xZAPS", detail: "0xZAPS/aeWETH pool" },
  { title: "Settle to wallet", detail: "sweep proceeds, check min-out" },
] as const;

// Where each card scatters from (viewport-relative units, hand-placed).
const SCATTER = [
  { x: -0.34, y: -0.22, r: -7 },
  { x: 0.3, y: -0.3, r: 5 },
  { x: -0.38, y: 0.16, r: 4 },
  { x: 0.36, y: 0.2, r: -5 },
  { x: 0.02, y: -0.38, r: 2 },
] as const;

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function Collapse(): React.JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const section = sectionRef.current;
    const capsule = capsuleRef.current;
    if (!section || !capsule) return;

    // The pinned stage needs ~660px of viewport height to show its full
    // choreography; below that (or on narrow screens) the static truth is
    // the better experience. Re-evaluated on resize, not just at mount.
    const canAnimate = () =>
      !window.matchMedia("(max-width: 860px)").matches && window.innerHeight >= 660;

    const resetStage = () => {
      cardRefs.current.forEach((card) => {
        if (!card) return;
        card.style.transform = "";
        card.style.opacity = "";
      });
      capsule.style.transform = "";
      capsule.style.opacity = "";
      delete capsule.dataset.lit;
    };

    const applyMode = () => {
      if (canAnimate()) {
        section.dataset.animated = "true";
      } else if (section.dataset.animated) {
        delete section.dataset.animated;
        resetStage();
      }
    };
    applyMode();
    window.addEventListener("resize", applyMode);

    let lastCount = -1;
    let lastY = -1;
    const unsubscribe = scrollBus.subscribe(({ y }) => {
      if (!section.dataset.animated) return;
      if (Math.abs(y - lastY) < 0.5) return;
      lastY = y;
      const rect = section.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      if (span <= 0) return;
      const p = clamp(-rect.top / span, 0, 1);
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;

      const vw = Math.min(window.innerWidth, 1440);
      const vh = window.innerHeight;

      cardRefs.current.forEach((card, i) => {
        if (!card) return;
        const scatter = SCATTER[i];
        // Arrive: each card flies in on its own offset window.
        const arrive = easeOut(clamp((p - i * 0.055) / 0.3, 0, 1));
        // Compress: all cards collapse into the centre together.
        const squash = easeOut(clamp((p - 0.58) / 0.24, 0, 1));
        const slotY = (i - (MANUAL_STEPS.length - 1) / 2) * 64;
        const x = scatter.x * vw * (1 - arrive) * 0.9;
        const y = scatter.y * vh * (1 - arrive) + slotY * arrive * (1 - squash) - squash * slotY * 0;
        const rot = scatter.r * (1 - arrive);
        const scale = (0.92 + arrive * 0.08) * (1 - squash * 0.82);
        const opacity = arrive * (1 - easeOut(clamp((p - 0.62) / 0.18, 0, 1)));
        card.style.transform = `translate3d(${x.toFixed(1)}px, ${(y * (1 - squash)).toFixed(1)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        card.style.opacity = opacity.toFixed(3);
      });

      // Counter narrates how many actions remain visible.
      const compressed = clamp((p - 0.58) / 0.24, 0, 1);
      const remaining = compressed >= 1 ? 1 : Math.max(1, Math.round(5 - compressed * 4));
      if (remaining !== lastCount && counterRef.current) {
        lastCount = remaining;
        counterRef.current.textContent =
          remaining === 1 ? "1 signed step" : `${remaining} manual actions`;
      }

      const bloom = easeOut(clamp((p - 0.72) / 0.22, 0, 1));
      capsule.style.transform = `translate(-50%, -50%) scale(${(0.55 + bloom * 0.45).toFixed(3)})`;
      capsule.style.opacity = bloom.toFixed(3);
      capsule.dataset.lit = bloom > 0.85 ? "true" : "false";
    });

    return () => {
      unsubscribe();
      window.removeEventListener("resize", applyMode);
      delete section.dataset.animated;
    };
  }, []);

  return (
    <section
      id="product"
      ref={sectionRef}
      className={styles.collapseSection}
      aria-labelledby="collapse-title"
    >
      <div className={styles.collapseSticky}>
        <div className={`container ${styles.collapseInner}`}>
          <header className={styles.collapseHead}>
            <p className={styles.kicker}>What is a Zap</p>
            <h2 id="collapse-title" className={styles.sectionTitle}>
              A Zap compresses a sequence of onchain actions into one transaction.
            </h2>
            <p className={`${styles.collapseCounter} mono`}>
              <span ref={counterRef}>5 manual actions</span>
            </p>
          </header>

          <div className={styles.collapseStage} aria-hidden="true">
            {MANUAL_STEPS.map((step, i) => (
              <div
                key={step.title}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                className={styles.collapseCard}
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className={`${styles.collapseCardIndex} mono`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={styles.collapseCardTitle}>{step.title}</span>
                <span className={`${styles.collapseCardDetail} mono`}>{step.detail}</span>
              </div>
            ))}

            <div ref={capsuleRef} className={styles.collapseCapsule}>
              <span className={styles.collapseCapsuleRing} />
              <span className={`${styles.collapseCapsuleKicker} mono`}>One Zap</span>
              <span className={styles.collapseCapsuleTitle}>USDG → 0xZAPS</span>
              <span className={`${styles.collapseCapsuleMeta} mono`}>
                one signed step · minOut enforced
              </span>
            </div>
          </div>

          {/* Static truth for reduced motion, small screens, and no-JS. */}
          <div className={styles.collapseStatic}>
            <ol className={styles.collapseStaticList}>
              {MANUAL_STEPS.map((step, i) => (
                <li key={step.title} className={styles.collapseStaticItem}>
                  <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                  {step.title}
                </li>
              ))}
            </ol>
            <div className={styles.collapseStaticArrow} aria-hidden="true">
              ↓
            </div>
            <div className={styles.collapseStaticCapsule}>
              <span className={`${styles.collapseCapsuleKicker} mono`}>One Zap</span>
              <span className={styles.collapseCapsuleTitle}>USDG → 0xZAPS</span>
              <span className={`${styles.collapseCapsuleMeta} mono`}>
                one signed step · minOut enforced
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
