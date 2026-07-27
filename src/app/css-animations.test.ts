import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `animation-name` a CSS Module references must be declared in that same
 * file.
 *
 * Turbopack scopes `animation-name` per module, exactly as it scopes class
 * names. So a rule that says `animation: zpulse 2.4s infinite` while `zpulse`
 * lives in globals.css does not fall back and does not warn — the declaration
 * is dropped, `getComputedStyle(el).animationName` computes to `none`, and the
 * element simply never moves.
 *
 * That failure mode is invisible in review and invisible in a screenshot. It has
 * already happened twice in this codebase: once to the landing page's keyframes
 * (hence the note at the top of landing.module.css) and once to the app shell's
 * live-reading pulse, where a static dot went on claiming to be a live feed.
 * Hence a test rather than a comment.
 */

const ROOT = "src";

function cssModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...cssModules(path));
    else if (entry.endsWith(".module.css")) out.push(path);
  }
  return out;
}

/**
 * Remove every balanced `name(...)` group from a value.
 *
 * Depth-aware, because `calc(760ms - var(--i) * 55ms)` nests and
 * `cubic-bezier(0.22, 1, 0.36, 1)` contains the commas that separate animation
 * layers — split on those first and the easing function shreds into fragments
 * that then look like keyframe names.
 */
function stripFunctions(value: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(") {
      depth += 1;
      // Drop the function's own identifier along with its arguments.
      if (depth === 1) out = out.replace(/[\w-]+$/, " ");
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

/** Animation names a stylesheet asks for, from both the shorthand and longhand. */
function referenced(css: string): Set<string> {
  const names = new Set<string>();

  for (const match of css.matchAll(/animation-name:\s*([^;}]+)/g)) {
    for (const name of stripFunctions(match[1]).split(",")) {
      const word = name.trim();
      if (word) names.add(word);
    }
  }

  // In the shorthand, the name is whichever token is not a time, an easing, a
  // count, a direction, a fill-mode or a play-state.
  const reserved = new Set([
    "none", "initial", "inherit", "unset", "revert", "infinite", "normal", "reverse",
    "alternate", "alternate-reverse", "forwards", "backwards", "both", "running",
    "paused", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start",
    "step-end", "important",
  ]);
  for (const match of css.matchAll(/(?<![-\w])animation:\s*([^;}]+)/g)) {
    for (const layer of stripFunctions(match[1]).split(",")) {
      for (const token of layer.trim().split(/\s+/)) {
        const word = token.replace(/^!/, "").replace(/!$/, "");
        if (!word || reserved.has(word.toLowerCase())) continue;
        if (/^-?[\d.]+m?s$/.test(word)) continue; // duration or delay
        if (/^-?[\d.]+$/.test(word)) continue; // iteration count
        names.add(word);
      }
    }
  }

  names.delete("none");
  return names;
}

function declared(css: string): Set<string> {
  return new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
}

describe("CSS Module animations are self-contained", () => {
  const modules = cssModules(ROOT);

  it("finds the stylesheets to check", () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  for (const path of modules) {
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    const wanted = [...referenced(css)];
    if (!wanted.length) continue;

    it(`${path} declares every keyframe it animates`, () => {
      const local = declared(css);
      const missing = wanted.filter((name) => !local.has(name));
      expect(
        missing,
        `${path} animates ${missing.join(", ")} but declares no @keyframes for it. ` +
          "Turbopack scopes animation-name per module, so this resolves to nothing " +
          "and the element never animates. Copy the @keyframes into this file.",
      ).toEqual([]);
    });
  }
});
