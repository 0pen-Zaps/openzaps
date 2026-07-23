"use client";

import { useEffect, useRef } from "react";
import { ZapLinesMark } from "@/components/ZapLinesMark";
import { clamp, damp, finePointer, reducedMotion } from "./motion";
import styles from "./landing.module.css";

/**
 * The cursor is the brand bolt, small and quiet: one scanline mark that
 * follows the pointer on a stiff spring, warms slightly over interactive
 * elements, and dips on press. No droplet body, no trailing glow — the
 * pointer is a pointer, not a light show.
 *
 * Interactive elements are classified by delegated pointerover (no
 * per-element listeners); magnetic targets get a small pull written back to
 * them as CSS variables. The component activates only on fine pointers with
 * motion allowed, and it stamps `data-cursor-active` on the landing root the
 * moment the bolt is actually visible — never before — so CSS hides the
 * native cursor exactly when the replacement exists.
 */

type CursorMode = "default" | "link" | "button" | "card" | "down";

const MAGNET_RANGE = 72;
const MAGNET_SHIFT = 5;

const MODE_SCALE: Record<CursorMode, number> = {
  default: 1,
  link: 1.1,
  button: 1.2,
  card: 1.35,
  down: 0.85,
};

export function Cursor(): React.JSX.Element | null {
  const boltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!finePointer() || reducedMotion()) return;
    const bolt = boltRef.current;
    const root = document.getElementById("landing-root");
    if (!bolt || !root) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    const pos = { x: targetX, y: targetY };
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
      bolt.dataset.mode = next;
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
        pos.x = targetX;
        pos.y = targetY;
        bolt.style.opacity = "1";
        // Hide the native cursor only once the bolt actually exists — a page
        // reached by keyboard or scroll keeps its cursor until then.
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
      bolt.style.opacity = "0";
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

      // Stiff spring: the bolt is the only pointer indicator, so it must not
      // lag far enough to make precise pointing feel loose.
      pos.x = damp(pos.x, goalX, 30, dt);
      pos.y = damp(pos.y, goalY, 30, dt);
      const targetScale = MODE_SCALE[mode];
      scale = damp(scale, targetScale, 14, dt);

      bolt.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;

      const settled =
        Math.abs(pos.x - goalX) < 0.15 &&
        Math.abs(pos.y - goalY) < 0.15 &&
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
    <div ref={boltRef} className={styles.cursorBolt} data-mode="default" aria-hidden="true">
      <ZapLinesMark lines={9} weight={0.68} />
    </div>
  );
}
