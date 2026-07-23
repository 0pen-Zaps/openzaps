"use client";

import { useEffect, useRef } from "react";
import { ZapLinesMark } from "@/components/ZapLinesMark";
import { damp, finePointer, pointerBus, reducedMotion } from "./motion";
import styles from "./landing.module.css";

/**
 * The Zap Core: the execution engine floating in the hero.
 *
 * Layered composition — breathing glass discs, two orbital shells of protocol
 * nodes (bright = carries a deployed route, dim = typed into the catalog),
 * routing paths with travelling yellow pulses, and the scanline bolt from the
 * brand system as the reactor heart. The pointer tilts the whole stage in
 * perspective; every layer's motion is CSS so reduced-motion collapses it to
 * a lit, static object.
 */

const CENTER = 360;

type CoreNode = {
  label: string;
  angle: number;
  radius: number;
  deployed: boolean;
};

// Real protocol surface: two protocols carry deployed routes today, the rest
// are typed into the block catalog. Angles are hand-placed for composition.
const NODES: CoreNode[] = [
  { label: "Uniswap v4", angle: -28, radius: 190, deployed: true },
  { label: "OpenZaps vault", angle: 152, radius: 190, deployed: true },
  { label: "Morpho", angle: -95, radius: 296, deployed: false },
  { label: "Aave", angle: -45, radius: 296, deployed: false },
  { label: "Compound", angle: 12, radius: 296, deployed: false },
  { label: "Aerodrome", angle: 64, radius: 296, deployed: false },
  { label: "Canonical bridge", angle: 132, radius: 296, deployed: false },
  { label: "Wrapped native", angle: 198, radius: 296, deployed: false },
];

function polar(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER + Math.cos(rad) * radius, y: CENTER + Math.sin(rad) * radius };
}

// Routing paths: from a node, bending through the core, out to another node.
function routePath(fromAngle: number, fromR: number, toAngle: number, toR: number): string {
  const a = polar(fromAngle, fromR);
  const b = polar(toAngle, toR);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${CENTER} ${CENTER} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

const ROUTES = [
  { d: routePath(-95, 296, 152, 190), dur: 5.2, delay: 0 },
  { d: routePath(-28, 190, 132, 296), dur: 6.4, delay: -2.1 },
  { d: routePath(12, 296, 198, 296), dur: 7.8, delay: -4.4 },
  { d: routePath(64, 296, -28, 190), dur: 6.9, delay: -1.2 },
];

export function ZapCore(): React.JSX.Element {
  const tiltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!finePointer() || reducedMotion()) return;
    const stage = tiltRef.current;
    if (!stage) return;
    let frame = 0;
    let running = false;
    let lastTime = performance.now();
    const tilt = { x: 0, y: 0 };
    const tick = (time: number) => {
      const dt = Math.min(64, time - lastTime);
      lastTime = time;
      const pointer = pointerBus.peek();
      if (Math.abs(tilt.x - pointer.nx) < 0.001 && Math.abs(tilt.y - pointer.ny) < 0.001) {
        // Caught up with the pointer — park until it moves again.
        running = false;
        return;
      }
      tilt.x = damp(tilt.x, pointer.nx, 4, dt);
      tilt.y = damp(tilt.y, pointer.ny, 4, dt);
      stage.style.transform = `rotateX(${(-tilt.y * 5).toFixed(2)}deg) rotateY(${(tilt.x * 7).toFixed(2)}deg)`;
      frame = requestAnimationFrame(tick);
    };
    const unsubscribe = pointerBus.subscribe(() => {
      if (running) return;
      running = true;
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, []);

  return (
    <div className={styles.coreStage} aria-hidden="true">
      <div ref={tiltRef} className={styles.coreTilt}>
        <svg viewBox="0 0 720 720" className={styles.coreSvg} fill="none">
          <defs>
            <radialGradient id="core-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fffc00" stopOpacity="0.14" />
              <stop offset="45%" stopColor="#fffc00" stopOpacity="0.04" />
              <stop offset="100%" stopColor="#fffc00" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="core-glass" cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.055" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0.015" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.05" />
            </radialGradient>
            <linearGradient id="core-route" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#fffc00" stopOpacity="0" />
              <stop offset="50%" stopColor="#fffc00" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#fffc00" stopOpacity="0" />
            </linearGradient>
          </defs>

          <circle cx={CENTER} cy={CENTER} r="330" fill="url(#core-halo)" />

          {/* Orbit guides */}
          <circle cx={CENTER} cy={CENTER} r="296" className={styles.coreOrbitGuide} />
          <circle cx={CENTER} cy={CENTER} r="190" className={styles.coreOrbitGuide} />

          {/* Routing paths: faint track + travelling pulse */}
          {ROUTES.map((route, i) => (
            <g key={i}>
              <path d={route.d} className={styles.coreRouteTrack} />
              <path
                d={route.d}
                className={styles.coreRoutePulse}
                style={{ "--dur": `${route.dur}s`, "--delay": `${route.delay}s` } as React.CSSProperties}
              />
            </g>
          ))}

          {/* Breathing glass discs */}
          <g className={styles.coreDiscs}>
            <circle cx={CENTER} cy={CENTER} r="150" fill="url(#core-glass)" className={styles.coreDiscA} />
            <circle cx={CENTER} cy={CENTER} r="110" fill="url(#core-glass)" className={styles.coreDiscB} />
            <circle cx={CENTER} cy={CENTER} r="74" fill="url(#core-glass)" className={styles.coreDiscC} />
          </g>

          {/* Protocol nodes: slow orbital drift, labels counter-rotated upright */}
          <g className={styles.coreOrbitSlow}>
            {NODES.filter((n) => !n.deployed).map((node) => {
              const p = polar(node.angle, node.radius);
              return (
                <g key={node.label} transform={`translate(${p.x} ${p.y})`}>
                  <g className={styles.coreCounterSlow}>
                    <circle r="5" className={styles.coreNodeDim} />
                    <text y="20" textAnchor="middle" className={styles.coreNodeLabel}>
                      {node.label}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
          <g className={styles.coreOrbitFast}>
            {NODES.filter((n) => n.deployed).map((node) => {
              const p = polar(node.angle, node.radius);
              return (
                <g key={node.label} transform={`translate(${p.x} ${p.y})`}>
                  <g className={styles.coreCounterFast}>
                    <circle r="10" className={styles.coreNodeHalo} />
                    <circle r="5.5" className={styles.coreNodeLive} />
                    <text y="24" textAnchor="middle" className={`${styles.coreNodeLabel} ${styles.coreNodeLabelLive}`}>
                      {node.label}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Reactor heart: the brand bolt, charged */}
        <div className={styles.coreBolt}>
          <ZapLinesMark lines={18} weight={0.62} motion="charge" />
        </div>

        {/* Floating execution metadata */}
        <div className={`${styles.coreChip} ${styles.coreChipA} mono`}>steps: 1 signed</div>
        <div className={`${styles.coreChip} ${styles.coreChipB} mono`}>minOut: enforced</div>
        <div className={`${styles.coreChip} ${styles.coreChipC} mono`}>recipient: owner</div>
      </div>
    </div>
  );
}
