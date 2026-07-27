import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, THEMES, THEME_BG, THEME_SCHEME } from "@/lib/theme";

/**
 * Guards for the five-theme token layer.
 *
 * Every failure mode below is silent in a browser. A token missing from one
 * theme block does not error — it inherits the default theme's value, so an
 * off-default theme quietly paints one element wrong and nobody notices until
 * a screenshot. A wrong `THEME_BG` entry is a mismatched band above the page
 * on mobile and nowhere else. These are the checks that turn "looks fine in
 * the theme I happen to use" into a build signal.
 */

const globals = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/**
 * The declarations inside one `[data-oz-theme="…"]` block.
 *
 * DEFAULT_THEME's block is the one that also carries `:root`, which is what a
 * server render and a JS-disabled visitor get. Looking it up by that compound
 * marker means a DEFAULT_THEME change that skips globals.css fails here
 * instead of shipping a first paint in the wrong theme.
 */
function themeBlock(theme: string): string {
  const marker = theme === DEFAULT_THEME ? `:root,\n[data-oz-theme="${theme}"] {` : `[data-oz-theme="${theme}"] {`;
  const start = globals.indexOf(marker);
  expect(start, `no token block for "${theme}" in globals.css`).toBeGreaterThan(-1);
  return globals.slice(start, globals.indexOf("\n}", start));
}

function declaredTokens(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]));
}

function hex(block: string, token: string): string {
  return block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
}

describe("theme token parity", () => {
  const base = declaredTokens(themeBlock(DEFAULT_THEME));

  it("declares a meaningful number of tokens on the default theme", () => {
    // A sanity floor: if the default block were truncated by an edit, every
    // comparison below would pass against almost nothing.
    expect(base.size).toBeGreaterThan(50);
  });

  it("puts the default theme's block first, so `:root` loses every tie", () => {
    // `:root` and `[data-oz-theme="x"]` are both (0,1,0). Nothing but source
    // order decides which wins, so the block carrying `:root` must come before
    // the other four — below them it would override each in turn and every
    // theme would silently paint the default.
    const rootAt = globals.indexOf(`:root,\n[data-oz-theme="${DEFAULT_THEME}"] {`);
    for (const theme of THEMES.filter((candidate) => candidate !== DEFAULT_THEME)) {
      expect(globals.indexOf(`[data-oz-theme="${theme}"] {`), `${theme} is declared before the \`:root\` block`).toBeGreaterThan(rootAt);
    }
  });

  for (const theme of THEMES.filter((candidate) => candidate !== DEFAULT_THEME)) {
    it(`"${theme}" overrides every token ${DEFAULT_THEME} declares`, () => {
      const missing = [...base].filter((token) => !declaredTokens(themeBlock(theme)).has(token));
      // An unoverridden token falls through to the default theme's value —
      // one element painted from the wrong palette, with no error anywhere.
      expect(missing, `${theme} is missing: ${missing.join(", ")}`).toEqual([]);
    });

    it(`"${theme}" introduces no token the other themes lack`, () => {
      const extra = [...declaredTokens(themeBlock(theme))].filter((token) => !base.has(token));
      expect(extra, `${theme} declares tokens no other theme has: ${extra.join(", ")}`).toEqual([]);
    });
  }
});

describe("theme metadata tracks the stylesheet", () => {
  it("THEME_BG matches each block's --bg", () => {
    for (const theme of THEMES) {
      expect(hex(themeBlock(theme), "--bg").toLowerCase(), `--bg for ${theme}`).toBe(THEME_BG[theme].toLowerCase());
    }
  });

  it("THEME_SCHEME agrees with whether --ink is lighter than --bg", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      const inverted = luminance(hex(block, "--ink")) > luminance(hex(block, "--bg"));
      expect(THEME_SCHEME[theme], `${theme} declares the wrong color-scheme`).toBe(inverted ? "dark" : "light");
    }
  });
});

describe("the contrast traps the token layer exists to prevent", () => {
  it("keeps --ink and --on-zap on opposite sides on the dark themes", () => {
    // --on-zap is ink ON the brand yellow. Reaching for --ink there is the
    // mistake this token exists to prevent: on a dark theme --ink is light,
    // and light text on #FFFC00 is unreadable.
    for (const theme of ["graphite", "voltage", "dusk"] as const) {
      const block = themeBlock(theme);
      expect(luminance(hex(block, "--on-zap")), `${theme}: --on-zap must be dark`).toBeLessThan(0.2);
      expect(luminance(hex(block, "--ink")), `${theme}: --ink must be light`).toBeGreaterThan(0.5);
    }
  });

  it("gives every theme at least 4.5:1 for --on-zap on --zap", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      expect(contrast(hex(block, "--zap"), hex(block, "--on-zap")), `${theme}: text on the brand fill`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps --zap-on-btn legible on --btn, including where the fill is the brand", () => {
    // Voltage is the case that motivates the token: there --btn IS #FFFC00, so
    // a brand mark painted --zap would vanish into its own button.
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      expect(contrast(hex(block, "--btn"), hex(block, "--zap-on-btn")), `${theme}: brand mark on the primary fill`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the primary button's own label above AA", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      expect(contrast(hex(block, "--btn"), hex(block, "--btn-ink")), `${theme}: --btn-ink on --btn`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps --ink-3 above AA on every surface it labels", () => {
    // --ink-3 carries every 10.5–12.5px meta label in the app and is the
    // tightest pair in the system. The handoff says: do not lighten it.
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      for (const surface of ["--sunk", "--panel", "--bg"]) {
        expect(contrast(hex(block, surface), hex(block, "--ink-3")), `${theme}: --ink-3 on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps body ink well clear of AAA on the app ground", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      expect(contrast(hex(block, "--bg"), hex(block, "--ink")), `${theme}: --ink on --bg`).toBeGreaterThanOrEqual(7);
    }
  });
});

function channel(value: string, at: number): number {
  const part = parseInt(value.slice(at, at + 2), 16) / 255;
  return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
}

function luminance(value: string): number {
  return 0.2126 * channel(value, 1) + 0.7152 * channel(value, 3) + 0.0722 * channel(value, 5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
