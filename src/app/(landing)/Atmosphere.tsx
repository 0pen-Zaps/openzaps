"use client";

import { useEffect, useRef } from "react";
import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import {
  clamp,
  damp,
  deviceQuality,
  pointerBus,
  scrollBus,
} from "./motion";
import styles from "./landing.module.css";

/**
 * The landing page's deepest layer: an etched circuit plane with one armed
 * route carrying current through square policy gates into the Zap Core.
 *
 * Hand-rolled rather than three.js: the whole scene is a fullscreen triangle
 * and a small deterministic fragment shader, so a renderer dependency would
 * be pure overhead. The canvas is fixed behind all content; JS feeds it damped
 * pointer, scroll progress, and scroll velocity. Reduced motion renders one
 * intentionally static armed route and stops. If WebGL is unavailable the
 * component quietly yields to the CSS circuit ground behind it.
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
uniform float u_layout;  // 0 stacked | 1 two-column hero

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdBox(vec2 p, vec2 halfSize) {
  vec2 d = abs(p) - halfSize;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float routeDistance(
  vec2 p,
  vec2 a,
  vec2 b,
  vec2 c,
  vec2 d,
  vec2 e
) {
  float ab = sdSegment(p, a, b);
  float bc = sdSegment(p, b, c);
  float cd = sdSegment(p, c, d);
  float de = sdSegment(p, d, e);
  return min(min(ab, bc), min(cd, de));
}

float strokeFromDistance(float distanceToPath, float width) {
  float antialias = max(fwidth(distanceToPath) * 1.35, 0.00065);
  return 1.0 - smoothstep(width, width + antialias, distanceToPath);
}

float squareGate(vec2 p, vec2 position, float size) {
  float distanceToEdge = abs(sdBox(p - position, vec2(size)));
  return strokeFromDistance(distanceToEdge, 0.0012);
}

vec2 routePoint(
  vec2 a,
  vec2 b,
  vec2 c,
  vec2 d,
  vec2 e,
  float progress
) {
  float ab = length(b - a);
  float bc = length(c - b);
  float cd = length(d - c);
  float de = length(e - d);
  float total = ab + bc + cd + de;
  float distanceAlong = clamp(progress, 0.0, 1.0) * total;

  if (distanceAlong <= ab) {
    return mix(a, b, distanceAlong / max(ab, 0.0001));
  }
  distanceAlong -= ab;
  if (distanceAlong <= bc) {
    return mix(b, c, distanceAlong / max(bc, 0.0001));
  }
  distanceAlong -= bc;
  if (distanceAlong <= cd) {
    return mix(c, d, distanceAlong / max(cd, 0.0001));
  }
  distanceAlong -= cd;
  return mix(d, e, distanceAlong / max(de, 0.0001));
}

// A compact head plus a short, fading tail. The loop count is fixed so even
// the lowest quality tier gets the same authored timing without dynamic work.
vec2 currentPacket(
  vec2 p,
  vec2 a,
  vec2 b,
  vec2 c,
  vec2 d,
  vec2 e,
  float progress
) {
  float core = 0.0;
  float halo = 0.0;
  for (int i = 0; i < 7; i++) {
    float index = float(i);
    float fade = 1.0 - index / 7.0;
    vec2 point = routePoint(a, b, c, d, e, max(0.0, progress - index * 0.018));
    float distanceToPoint = length(p - point);
    float coreRadius = mix(0.0055, 0.0022, index / 6.0);
    float haloRadius = mix(0.027, 0.008, index / 6.0);
    float antialias = max(fwidth(distanceToPoint), 0.00065);
    core = max(
      core,
      (1.0 - smoothstep(coreRadius, coreRadius + antialias, distanceToPoint)) * fade
    );
    halo = max(
      halo,
      (1.0 - smoothstep(haloRadius, haloRadius + antialias, distanceToPoint)) * fade
    );
  }
  return vec2(core, halo);
}

void main() {
  float aspect = u_res.x / u_res.y;
  float desktop = u_layout;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  float velocity = clamp(u_vel / 90.0, -1.0, 1.0);

  // The circuit plane follows the pointer by only a few pixels. Current
  // intensity, not the geometry, responds to scroll velocity.
  p += u_ptr * mix(vec2(0.010, 0.008), vec2(0.017, 0.012), desktop);

  // On wide screens the focal point sits under the right-hand Zap Core. On a
  // stacked hero it rises to the top-centre visual. The final page beat pulls
  // it back to a single central point.
  float darken = smoothstep(0.72, 0.97, u_scroll);
  vec2 heroHub = vec2(
    mix(0.0, aspect * 0.285, desktop),
    mix(0.235, 0.015, desktop)
  );
  vec2 hub = mix(heroHub, vec2(0.0, 0.02), darken);
  float edgeLeft = -0.5 * aspect - 0.08;
  float edgeRight = 0.5 * aspect + 0.08;

  // One armed route enters from the right and crosses three explicit policy
  // gates before settling into the core.
  vec2 a0 = vec2(edgeRight, hub.y + 0.10);
  vec2 b0 = vec2(hub.x + 0.46, hub.y + 0.10);
  vec2 c0 = vec2(hub.x + 0.46, hub.y - 0.22);
  vec2 d0 = vec2(hub.x, hub.y - 0.22);
  vec2 e0 = hub;

  // Dormant possibilities stay etched into the board. Quality tiers reveal
  // more branches, but the topology remains authored and deterministic.
  vec2 a1 = vec2(edgeLeft, 0.46);
  vec2 b1 = vec2(hub.x - 0.55, 0.46);
  vec2 c1 = vec2(hub.x - 0.55, hub.y + 0.26);
  vec2 d1 = vec2(hub.x, hub.y + 0.26);
  vec2 e1 = hub;

  vec2 a2 = vec2(edgeLeft, -0.48);
  vec2 b2 = vec2(hub.x - 0.38, -0.48);
  vec2 c2 = vec2(hub.x - 0.38, hub.y - 0.28);
  vec2 d2 = vec2(hub.x, hub.y - 0.28);
  vec2 e2 = hub;

  vec2 a3 = vec2(hub.x - 0.10, 0.64);
  vec2 b3 = vec2(hub.x - 0.10, hub.y + 0.36);
  vec2 c3 = vec2(hub.x + 0.26, hub.y + 0.36);
  vec2 d3 = vec2(hub.x + 0.26, hub.y);
  vec2 e3 = hub;

  vec2 a4 = vec2(hub.x - 0.08, -0.64);
  vec2 b4 = vec2(hub.x - 0.08, hub.y - 0.34);
  vec2 c4 = vec2(hub.x + 0.26, hub.y - 0.34);
  vec2 d4 = vec2(hub.x + 0.26, hub.y);
  vec2 e4 = hub;

  vec2 a5 = vec2(edgeRight, 0.48);
  vec2 b5 = vec2(hub.x + 0.52, 0.48);
  vec2 c5 = vec2(hub.x + 0.52, hub.y + 0.26);
  vec2 d5 = vec2(hub.x, hub.y + 0.26);
  vec2 e5 = hub;

  vec2 a6 = vec2(edgeRight, -0.50);
  vec2 b6 = vec2(hub.x + 0.34, -0.50);
  vec2 c6 = vec2(hub.x + 0.34, hub.y - 0.30);
  vec2 d6 = vec2(hub.x, hub.y - 0.30);
  vec2 e6 = hub;

  float activeDistance = routeDistance(p, a0, b0, c0, d0, e0);
  float activeCore = strokeFromDistance(activeDistance, 0.0014);
  float activeGlow = strokeFromDistance(activeDistance, 0.010);

  float dormantDistance = min(
    routeDistance(p, a1, b1, c1, d1, e1),
    routeDistance(p, a5, b5, c5, d5, e5)
  );
  if (u_quality > 0.5) {
    dormantDistance = min(
      dormantDistance,
      min(
        routeDistance(p, a2, b2, c2, d2, e2),
        routeDistance(p, a6, b6, c6, d6, e6)
      )
    );
  }
  if (u_quality > 1.5) {
    dormantDistance = min(
      dormantDistance,
      min(
        routeDistance(p, a3, b3, c3, d3, e3),
        routeDistance(p, a4, b4, c4, d4, e4)
      )
    );
  }
  float dormantCore = strokeFromDistance(dormantDistance, 0.0008);
  float dormantGlow = strokeFromDistance(dormantDistance, 0.006);

  float dormantGates = max(
    max(squareGate(p, b1, 0.010), squareGate(p, c1, 0.010)),
    max(squareGate(p, b5, 0.010), squareGate(p, c5, 0.010))
  );
  if (u_quality > 0.5) {
    dormantGates = max(
      dormantGates,
      max(squareGate(p, c2, 0.010), squareGate(p, c6, 0.010))
    );
  }
  if (u_quality > 1.5) {
    dormantGates = max(
      dormantGates,
      max(squareGate(p, c3, 0.010), squareGate(p, c4, 0.010))
    );
  }

  float activeGates = max(
    squareGate(p, b0, 0.013),
    max(squareGate(p, c0, 0.013), squareGate(p, d0, 0.013))
  );

  // One packet crosses the armed route in 2.8 seconds, then the system rests.
  // The initial phase puts a frozen reduced-motion frame in that rest state.
  float primaryCycle = mod(t + 6.4, 8.4);
  float primaryProgress = clamp(primaryCycle / 2.8, 0.0, 1.0);
  float primaryVisible =
    smoothstep(0.0, 0.16, primaryCycle) *
    (1.0 - smoothstep(2.65, 3.05, primaryCycle));
  vec2 primaryPacket =
    currentPacket(p, a0, b0, c0, d0, e0, primaryProgress) *
    primaryVisible;

  // Full-quality devices get a fainter second packet on the same bounded
  // route, never a second authorised branch.
  float secondaryCycle = mod(t + 3.4, 8.4);
  float secondaryProgress = clamp(secondaryCycle / 2.8, 0.0, 1.0);
  float secondaryVisible =
    smoothstep(0.0, 0.16, secondaryCycle) *
    (1.0 - smoothstep(2.65, 3.05, secondaryCycle));
  vec2 secondaryPacket = vec2(0.0);
  if (u_quality > 1.5) {
    secondaryPacket =
      currentPacket(p, a0, b0, c0, d0, e0, secondaryProgress) *
      secondaryVisible * 0.42;
  }
  vec2 packet = max(primaryPacket, secondaryPacket);
  vec2 packetHead = routePoint(a0, b0, c0, d0, e0, primaryProgress);
  float gateCharge =
    (1.0 - smoothstep(0.025, 0.13, length(packetHead - b0))) +
    (1.0 - smoothstep(0.025, 0.13, length(packetHead - c0))) +
    (1.0 - smoothstep(0.025, 0.13, length(packetHead - d0)));
  gateCharge = clamp(gateCharge, 0.0, 1.0) * primaryVisible;

  // Keep the circuit out of the desktop copy block and below the mobile hero
  // visual. The nav receives an additional quiet band.
  vec2 copyCentre = vec2(-aspect * 0.27, 0.02);
  float copyDistance = length((p - copyCentre) * vec2(0.78, 1.12));
  float desktopQuiet = mix(0.16, 1.0, smoothstep(0.27, 0.61, copyDistance));
  float mobileQuiet = smoothstep(-0.18, 0.07, p.y);
  float readability = mix(mobileQuiet, desktopQuiet, desktop);
  float navQuiet = 1.0 - smoothstep(0.48, 0.62, p.y);
  readability *= navQuiet;

  // A soft void keeps the background circuit from fighting the hero reactor.
  float hubDistance = length(p - hub);
  float coreQuiet = mix(0.24, 1.0, smoothstep(0.11, 0.27, hubDistance));
  float resolutionFade = 1.0 - darken;
  float dormantFade = resolutionFade * readability * coreQuiet;
  float activeFade = resolutionFade * mix(0.66, 1.0, coreQuiet);

  vec3 ground = vec3(0.009, 0.009, 0.008);
  vec3 boardLift = vec3(0.045, 0.043, 0.018);
  vec3 dormantInk = vec3(0.56, 0.55, 0.36);
  vec3 yellow = vec3(1.0, 0.988, 0.0);
  vec3 amber = vec3(1.0, 0.63, 0.08);

  float hubLift = 1.0 - smoothstep(0.08, 0.64, hubDistance);
  vec3 color = ground + boardLift * hubLift * resolutionFade;
  color += dormantInk * dormantGlow * 0.018 * dormantFade;
  color += dormantInk * dormantCore * 0.060 * dormantFade;
  color += dormantInk * dormantGates * 0.075 * dormantFade;
  color += yellow * activeGlow * 0.030 * activeFade;
  color += yellow * activeCore * 0.145 * activeFade;
  color += yellow * activeGates * (0.12 + gateCharge * 0.24) * activeFade;

  float packetGain = 1.0 + abs(velocity) * 0.85;
  color += amber * packet.y * 0.10 * packetGain * resolutionFade;
  color += yellow * packet.x * 0.72 * packetGain * resolutionFade;

  // Three short conductors echo the ZapLines scanline rhythm without drawing
  // behind the core itself.
  float bus = 0.0;
  for (int i = -1; i <= 1; i++) {
    float offset = float(i) * 0.018;
    bus = max(
      bus,
      strokeFromDistance(
        sdSegment(
          p,
          hub + vec2(-0.26, offset),
          hub + vec2(-0.13, offset)
        ),
        0.0009
      )
    );
    bus = max(
      bus,
      strokeFromDistance(
        sdSegment(
          p,
          hub + vec2(0.13, offset),
          hub + vec2(0.26, offset)
        ),
        0.0009
      )
    );
  }
  color += yellow * bus * 0.075 * resolutionFade;

  // As the page resolves, branches disappear and one point survives.
  float finalDistance = length(p - vec2(0.0, 0.02));
  float finalCore = 1.0 - smoothstep(0.0, 0.008, finalDistance);
  float finalHalo = 1.0 - smoothstep(0.0, 0.11, finalDistance);
  color += yellow * (finalCore * 0.72 + finalHalo * finalHalo * 0.10) * darken;

  float vignette = 1.0 - smoothstep(0.42, 1.12, length(p / vec2(max(aspect, 1.0), 1.0)));
  color *= mix(0.72, 1.0, vignette);

  outColor = vec4(color, 1.0);
}
`;

export function Atmosphere(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotionPreference();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Any init failure hides the canvas: an opaque WebGL surface that never
    // draws would paint flat black over the authored circuit fallback.
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
      layout: gl.getUniformLocation(program, "u_layout"),
    };

    const quality = deviceQuality();
    const still = reduced;
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
      gl.uniform1f(loc.layout, window.innerWidth > 1020 ? 1 : 0);
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
    // The scroll subscription still resolves many traces into the final point,
    // but always draws at u_time = 0 — no current packet travels and quiet
    // frames cost nothing.
    let unsubscribeScroll: (() => void) | null = null;
    let unsubscribePointer: (() => void) | null = null;
    if (still) {
      draw(start);
      let lastY = -1;
      let lastProgress = -1;
      unsubscribeScroll = scrollBus.subscribe((s) => {
        if (contextLost || (s.y === lastY && s.progress === lastProgress)) return;
        lastY = s.y;
        lastProgress = s.progress;
        draw(start);
      });
    } else {
      // Atmosphere used to rely on ZapCore and VelocityFx to keep these buses
      // alive. Owning the subscriptions here makes the background's pointer
      // and velocity inputs independent of sibling mount order.
      unsubscribePointer = pointerBus.subscribe(() => {});
      unsubscribeScroll = scrollBus.subscribe(() => {});
      play();
    }

    const onVisibility = () => {
      if (document.hidden) pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // A lost context invalidates every GL resource this closure holds. Rather
    // than resume against a dead context, fade the canvas out and let the CSS
    // circuit fallback behind it carry the scene.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      pause();
      canvas.style.opacity = "0";
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    return () => {
      pause();
      unsubscribeScroll?.();
      unsubscribePointer?.();
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
  }, [reduced]);

  return (
    <div className={styles.atmosphere} aria-hidden="true">
      <div className={styles.circuitFallback} />
      <canvas ref={canvasRef} className={styles.atmosphereCanvas} />
    </div>
  );
}
