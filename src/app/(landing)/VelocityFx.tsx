"use client";

import { useEffect } from "react";
import { clamp, reducedMotion, scrollBus } from "./motion";

/**
 * Publishes scroll physics to CSS and drives the DOM parallax layers.
 *
 * Writes onto the landing root:
 *   --scroll-progress  0..1 through the document
 *   --scroll-vel       -1..1 smoothed, signed velocity
 *   --motion-abs       0..1 absolute velocity (chromatic/stretch amount)
 *
 * Any element carrying `data-depth="<number>"` inside the landing drifts
 * against scroll at that rate (positive = recedes, negative = approaches).
 * Elements register once on mount; rects are re-read on resize only.
 * Renders nothing; under reduced motion it does nothing at all.
 */
export function VelocityFx(): null {
  useEffect(() => {
    if (reducedMotion()) return;
    const root = document.getElementById("landing-root");
    if (!root) return;

    type Layer = { el: HTMLElement; depth: number; top: number; height: number };
    let layers: Layer[] = [];

    const measure = () => {
      const scrollY = window.scrollY;
      layers = Array.from(root.querySelectorAll<HTMLElement>("[data-depth]")).map((el) => {
        // Neutralise our own transform before measuring.
        el.style.transform = "";
        const rect = el.getBoundingClientRect();
        return {
          el,
          depth: Number(el.dataset.depth) || 0,
          top: rect.top + scrollY,
          height: rect.height,
        };
      });
    };
    measure();
    window.addEventListener("resize", measure);
    // Late-mounting sections (dynamic imports) add layers after first paint.
    const settle = window.setTimeout(measure, 1200);

    const viewport = () => window.innerHeight;
    // Custom-property writes on the landing root invalidate style for the
    // whole subtree — skip every frame on which nothing meaningfully moved,
    // so an idle page costs nothing.
    let lastY = -1;
    let lastVel = 999;
    const unsubscribe = scrollBus.subscribe(({ y, velocity, progress }) => {
      const vel = clamp(velocity / 90, -1, 1);
      if (Math.abs(y - lastY) < 0.5 && Math.abs(vel - lastVel) < 0.004) return;
      lastY = y;
      lastVel = vel;
      root.style.setProperty("--scroll-progress", progress.toFixed(4));
      root.style.setProperty("--scroll-vel", vel.toFixed(3));
      root.style.setProperty("--motion-abs", Math.abs(vel).toFixed(3));

      const vh = viewport();
      for (const layer of layers) {
        // How far the layer's own band has travelled through the viewport.
        const local = (y + vh - layer.top) / (vh + layer.height);
        if (local < -0.2 || local > 1.2) continue;
        const shift = (local - 0.5) * layer.depth * vh * 0.2;
        layer.el.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
      }
    });

    return () => {
      unsubscribe();
      window.clearTimeout(settle);
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--scroll-progress");
      root.style.removeProperty("--scroll-vel");
      root.style.removeProperty("--motion-abs");
    };
  }, []);

  return null;
}
