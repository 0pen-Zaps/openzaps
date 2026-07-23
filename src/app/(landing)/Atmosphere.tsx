"use client";

import { useEffect, useRef } from "react";
import {
  clamp,
  damp,
  deviceQuality,
  pointerBus,
  reducedMotion,
  scrollBus,
} from "./motion";
import styles from "./landing.module.css";

/**
 * The landing page's deepest layer: volumetric fog, two angled light beams,
 * and a drifting particle field, all in one fullscreen WebGL2 fragment shader.
 *
 * Hand-rolled rather than three.js: the whole scene is a quad and ~90 lines
 * of GLSL, so a renderer dependency would be pure overhead. The canvas is
 * fixed behind all content; JS feeds it damped pointer, scroll progress, and
 * scroll velocity. Reduced motion renders exactly one frame and stops. If
 * WebGL is unavailable the component quietly renders nothing — the CSS ground
 * behind it already paints a static gradient fallback.
 */

const VERTEX = `#version 300 es
precision highp float;
const vec2 corners[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
void main() { gl_Position = vec4(corners[gl_VertexID], 0., 1.); }
`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_ptr;      // -1..1, damped
uniform float u_scroll;  // 0..1 page progress
uniform float u_vel;     // smoothed scroll velocity, px/frame
uniform float u_quality; // 0 | 1 | 2

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(
    mix(hash(i), hash(i + vec2(1., 0.)), u.x),
    mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// Soft particle grid: one candidate point per cell, glow by distance.
float particles(vec2 uv, float scale, float speed, float t) {
  vec2 p = uv * scale + vec2(0., -t * speed);
  vec2 cell = floor(p);
  float glow = 0.;
  vec2 site = vec2(hash(cell), hash(cell + 19.7));
  vec2 d = fract(p) - site;
  float dist = length(d);
  float twinkle = 0.6 + 0.4 * sin(t * (0.6 + hash(cell + 7.3)) + hash(cell) * 6.28);
  glow += smoothstep(0.09, 0.0, dist) * twinkle * step(0.55, hash(cell + 3.1));
  return glow;
}

// One angled volumetric beam through the scene.
float beam(vec2 uv, vec2 origin, vec2 dir, float width, float t) {
  vec2 rel = uv - origin;
  float along = dot(rel, dir);
  float across = abs(dot(rel, vec2(-dir.y, dir.x)));
  float body = smoothstep(width, 0., across) * smoothstep(-0.35, 0.45, along);
  float flicker = 0.75 + 0.25 * fbm(vec2(along * 2.2 - t * 0.11, across * 5.));
  return body * flicker;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  float velocity = clamp(u_vel / 80., -1., 1.);

  // Fast scrolling stretches the whole field vertically — the environment
  // elongating with motion — and settles as velocity decays.
  uv.y *= 1. - abs(velocity) * 0.12;
  uv += u_ptr * vec2(0.035, 0.025);

  // How lit the scene is: full in the hero, dimming toward the final CTA
  // until only the beams' convergence point survives.
  float darken = smoothstep(0.72, 0.97, u_scroll);
  float energy = 1. - darken * 0.85;

  vec3 ground = vec3(0.020, 0.020, 0.019);
  vec3 warm = vec3(0.055, 0.053, 0.038);
  vec3 yellow = vec3(1.0, 0.988, 0.0);

  // Depth fog.
  float fog = fbm(uv * 1.6 + vec2(t * 0.016, -u_scroll * 1.2));
  fog += 0.5 * fbm(uv * 3.4 - vec2(t * 0.011, u_scroll * 0.6));
  vec3 color = ground + warm * fog * energy;

  // Two beams that converge as the page ends.
  float squeeze = 1. - darken * 0.8;
  float b1 = beam(uv, vec2(-0.75 * squeeze, 0.42), normalize(vec2(0.82, -0.44)), 0.16 * squeeze + 0.02, t);
  float b2 = beam(uv, vec2(0.85 * squeeze, -0.5), normalize(vec2(-0.74, 0.52)), 0.13 * squeeze + 0.02, t);
  color += yellow * (b1 * 0.05 + b2 * 0.038) * energy;

  // Liquidity particles: two parallax layers rising like capital in flight.
  float drift = particles(uv, 11., 0.05, t) * 0.5;
  if (u_quality > 1.5) drift += particles(uv * 1.4 + 3.7, 19., 0.083, t) * 0.3;
  color += yellow * drift * 0.10 * energy;

  // The single surviving point of light at the very end of the page.
  float core = smoothstep(0.34, 0.0, length(uv - vec2(0.0, 0.02)));
  color += yellow * core * core * darken * 0.16;

  // Velocity splits the spectrum at the edges: cheap chromatic fringe that
  // only exists while scrolling fast, never on the text layers above.
  color.r += abs(velocity) * drift * 0.05;
  color.b += abs(velocity) * fog * 0.02;

  // Vignette.
  float vig = smoothstep(1.25, 0.35, length(uv));
  color *= mix(0.72, 1., vig);

  outColor = vec4(color, 1.0);
}
`;

export function Atmosphere(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Any init failure hides the canvas: an opaque WebGL surface that never
    // draws would paint flat black over the CSS gradient ground behind it.
    const fallback = () => {
      canvas.style.display = "none";
    };
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl || gl.isContextLost()) {
      fallback();
      return;
    }
    canvas.style.display = "";

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Atmosphere shader:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) {
      fallback();
      return;
    }
    const program = gl.createProgram();
    if (!program) {
      fallback();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Atmosphere link:", gl.getProgramInfoLog(program));
      fallback();
      return;
    }
    gl.useProgram(program);

    const loc = {
      res: gl.getUniformLocation(program, "u_res"),
      time: gl.getUniformLocation(program, "u_time"),
      ptr: gl.getUniformLocation(program, "u_ptr"),
      scroll: gl.getUniformLocation(program, "u_scroll"),
      vel: gl.getUniformLocation(program, "u_vel"),
      quality: gl.getUniformLocation(program, "u_quality"),
    };

    const quality = deviceQuality();
    const still = reducedMotion();
    const dprCap = quality === 2 ? 1.5 : quality === 1 ? 1.1 : 0.8;

    let width = 0;
    let height = 0;
    let contextLost = false;
    const start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      width = Math.round(window.innerWidth * dpr);
      height = Math.round(window.innerHeight * dpr);
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      // Setting canvas.width clears the buffer; a parked (reduced-motion)
      // frame must be repainted or the scene goes black on resize.
      if (still && !contextLost) draw(start);
    };

    let frame = 0;
    let running = false;
    let lastTime = start;
    const ptr = { x: 0, y: 0 };

    const draw = (time: number) => {
      const dt = Math.min(64, time - lastTime);
      lastTime = time;
      const pointer = pointerBus.peek();
      ptr.x = damp(ptr.x, pointer.nx, 3, dt);
      ptr.y = damp(ptr.y, pointer.ny, 3, dt);
      const scroll = scrollBus.peek();
      gl.uniform2f(loc.res, width, height);
      gl.uniform1f(loc.time, (time - start) / 1000);
      gl.uniform2f(loc.ptr, ptr.x, ptr.y);
      gl.uniform1f(loc.scroll, scroll.progress);
      gl.uniform1f(loc.vel, clamp(scroll.velocity, -120, 120));
      gl.uniform1f(loc.quality, quality);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (time: number) => {
      draw(time);
      frame = requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || still || contextLost) return;
      running = true;
      lastTime = performance.now();
      frame = requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    resize();
    window.addEventListener("resize", resize);

    // Reduced motion: paint one frame with frozen time, then stay parked.
    // The scroll subscription repositions the parked scene (fog offset,
    // end-of-page darkening) but always draws at u_time = 0 — nothing drifts,
    // flickers, or twinkles, and quiet frames cost nothing.
    let unsubscribe: (() => void) | null = null;
    if (still) {
      draw(start);
      let lastY = -1;
      let lastProgress = -1;
      unsubscribe = scrollBus.subscribe((s) => {
        if (contextLost || (s.y === lastY && s.progress === lastProgress)) return;
        lastY = s.y;
        lastProgress = s.progress;
        draw(start);
      });
    } else {
      play();
    }

    const onVisibility = () => {
      if (document.hidden) pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // A lost context invalidates every GL resource this closure holds. Rather
    // than resume against a dead context, fade the canvas out and let the CSS
    // gradient ground behind it carry the scene.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      pause();
      canvas.style.opacity = "0";
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    return () => {
      pause();
      unsubscribe?.();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      // Deliberately NOT calling WEBGL_lose_context.loseContext() here:
      // StrictMode runs mount → cleanup → mount in dev, and getContext() on
      // the same canvas returns the same (killed) context on the second
      // mount, bricking the scene. A discarded canvas releases its context
      // via GC; deleting the program/shaders above is the eager part.
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.atmosphere} aria-hidden="true" />;
}
