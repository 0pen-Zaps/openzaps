"use client";

import { useEffect, useRef } from "react";
import { clamp, damp, finePointer, reducedMotion } from "./motion";
import styles from "./landing.module.css";

/**
 * The liquid-yellow droplet cursor.
 *
 * Three layers follow the pointer at different spring rates: a crisp core dot,
 * a glossy droplet body, and a slow luminous trail. Interactive elements are
 * classified by delegated pointerover (no per-element listeners); magnetic
 * targets get a small pull written back to them as CSS variables.
 *
 * The component activates only on fine pointers with motion allowed, and it
 * stamps `data-cursor-active` on the landing root so CSS can hide the native
 * cursor exactly when — and only when — the replacement is alive.
 */

type CursorMode = "default" | "link" | "button" | "card" | "down";

const MAGNET_RANGE = 72;
const MAGNET_SHIFT = 5;

export function Cursor(): React.JSX.Element | null {
  const dotRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!finePointer() || reducedMotion()) return;
    const dot = dotRef.current;
    const drop = dropRef.current;
    const trail = trailRef.current;
    const root = document.getElementById("landing-root");
    if (!dot || !drop || !trail || !root) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    const pos = {
      dot: { x: targetX, y: targetY },
      drop: { x: targetX, y: targetY },
      trail: { x: targetX, y: targetY },
    };
    let mode: CursorMode = "default";
    let pressed = false;
    let magnet: HTMLElement | null = null;
    let seen = false;
    let scale = 1;
    let frame = 0;
    let running = false;
    let lastTime = performance.now();

    const setMode = (next: CursorMode) => {
      if (mode === next) return;
      mode = next;
      drop.dataset.mode = next;
      ensureRunning();
    };

    const classify = (element: Element | null): { mode: CursorMode; magnet: HTMLElement | null } => {
      if (!element) return { mode: "default", magnet: null };
      const card = element.closest<HTMLElement>("[data-cursor='card']");
      if (card) return { mode: "card", magnet: null };
      const magnetic = element.closest<HTMLElement>("[data-magnetic]");
      const interactive = element.closest<HTMLElement>(
        "a, button, [role='button'], input, select, textarea, summary, [data-cursor='link']",
      );
      if (interactive) {
        const isButton =
          interactive.matches("button, [role='button']") ||
          interactive.className.includes("btn");
        return { mode: isButton ? "button" : "link", magnet: magnetic };
      }
      return { mode: "default", magnet: null };
    };

    const releaseMagnet = () => {
      if (magnet) {
        magnet.style.removeProperty("--mag-x");
        magnet.style.removeProperty("--mag-y");
        magnet = null;
      }
    };

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      if (!seen) {
        seen = true;
        pos.dot = { x: targetX, y: targetY };
        pos.drop = { x: targetX, y: targetY };
        pos.trail = { x: targetX, y: targetY };
        dot.style.opacity = "1";
        drop.style.opacity = "1";
        trail.style.opacity = "1";
        // Hide the native cursor only once the droplet actually exists — a
        // page reached by keyboard or scroll keeps its cursor until then.
        root.setAttribute("data-cursor-active", "true");
      }
      ensureRunning();
    };

    const onOver = (event: PointerEvent) => {
      const next = classify(event.target as Element | null);
      setMode(pressed ? "down" : next.mode);
      if (next.magnet !== magnet) {
        releaseMagnet();
        magnet = next.magnet;
        ensureRunning();
      }
    };

    const onDown = () => {
      pressed = true;
      setMode("down");
    };
    const onUp = (event: PointerEvent) => {
      pressed = false;
      setMode(classify(event.target as Element | null).mode);
    };
    const onLeave = () => {
      dot.style.opacity = "0";
      drop.style.opacity = "0";
      trail.style.opacity = "0";
      seen = false;
      releaseMagnet();
      root.removeAttribute("data-cursor-active");
    };

    const tick = (time: number) => {
      const dt = Math.min(64, time - lastTime);
      lastTime = time;

      let goalX = targetX;
      let goalY = targetY;
      if (magnet && magnet.isConnected) {
        const rect = magnet.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = cx - targetX;
        const dy = cy - targetY;
        const dist = Math.hypot(dx, dy);
        if (dist < MAGNET_RANGE + Math.max(rect.width, rect.height) / 2) {
          const pull = 0.22;
          goalX = targetX + dx * pull;
          goalY = targetY + dy * pull;
          const shove = clamp(1 - dist / (MAGNET_RANGE * 2), 0, 1) * MAGNET_SHIFT;
          magnet.style.setProperty("--mag-x", `${(-dx / (dist || 1)) * -shove}px`);
          magnet.style.setProperty("--mag-y", `${(-dy / (dist || 1)) * -shove}px`);
        } else {
          magnet.style.setProperty("--mag-x", "0px");
          magnet.style.setProperty("--mag-y", "0px");
        }
      }

      pos.dot.x = damp(pos.dot.x, goalX, 38, dt);
      pos.dot.y = damp(pos.dot.y, goalY, 38, dt);
      pos.drop.x = damp(pos.drop.x, goalX, 17, dt);
      pos.drop.y = damp(pos.drop.y, goalY, 17, dt);
      pos.trail.x = damp(pos.trail.x, goalX, 6, dt);
      pos.trail.y = damp(pos.trail.y, goalY, 6, dt);

      const targetScale =
        mode === "down" ? 0.82 : mode === "card" ? 2.6 : mode === "button" ? 1.5 : mode === "link" ? 1.25 : 1;
      scale = damp(scale, targetScale, 14, dt);

      dot.style.transform = `translate3d(${pos.dot.x}px, ${pos.dot.y}px, 0)`;
      drop.style.transform = `translate3d(${pos.drop.x}px, ${pos.drop.y}px, 0) scale(${scale.toFixed(3)})`;
      const stretch = clamp(Math.hypot(goalX - pos.trail.x, goalY - pos.trail.y) / 120, 0, 0.55);
      trail.style.transform = `translate3d(${pos.trail.x}px, ${pos.trail.y}px, 0) scale(${(scale * (1 + stretch)).toFixed(3)})`;

      // Every layer caught up and nothing is pulling: park the loop. Any
      // pointer event (or scroll, which moves magnet rects) restarts it.
      const settled =
        Math.abs(pos.trail.x - goalX) < 0.15 &&
        Math.abs(pos.trail.y - goalY) < 0.15 &&
        Math.abs(scale - targetScale) < 0.002 &&
        !magnet;
      if (settled) {
        running = false;
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    const ensureRunning = () => {
      if (running) return;
      running = true;
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("scroll", ensureRunning, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    ensureRunning();

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      window.removeEventListener("scroll", ensureRunning);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      releaseMagnet();
      root.removeAttribute("data-cursor-active");
    };
  }, []);

  return (
    <div aria-hidden="true">
      <div ref={trailRef} className={styles.cursorTrail} />
      <div ref={dropRef} className={styles.cursorDrop} data-mode="default" />
      <div ref={dotRef} className={styles.cursorDot} />
    </div>
  );
}
