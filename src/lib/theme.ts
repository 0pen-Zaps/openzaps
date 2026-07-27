/**
 * The five app themes.
 *
 * A theme is nothing but a `data-oz-theme` value on <html>; every colour,
 * shadow and radius in the app resolves from the token block that attribute
 * selects in globals.css. The default sits on `:root` as well as on its own
 * attribute block, so a server render with no attribute — and a visitor with
 * JavaScript off — still gets a complete theme rather than unstyled tokens.
 *
 * `voltage` is the identity the app shipped with, preserved exactly, and the
 * default. Changing DEFAULT_THEME is a two-file edit: the `:root,` line in
 * globals.css has to move onto the new default's block AND that block has to
 * become the first of the five, because `:root` ties on specificity with every
 * `[data-oz-theme]` selector and only source order breaks the tie.
 */

export const THEME_STORAGE_KEY = "oz-theme-v1";

export const THEMES = ["ivory", "paper", "graphite", "voltage", "dusk"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "voltage";

/**
 * Browser-chrome colour per theme — the `--bg` of each block in globals.css.
 *
 * Duplicated out of CSS because `<meta name="theme-color">` cannot read a
 * custom property. Keep the two in step: a wrong value here is a mismatched
 * band above the page on mobile, not a crash, so nothing will tell you.
 */
export const THEME_BG: Record<Theme, string> = {
  ivory: "#F6F3EC",
  paper: "#F4F4F5",
  graphite: "#191712",
  voltage: "#050505",
  dusk: "#14161F",
};

/** Drives `color-scheme`, which is what themes the UA's own scrollbars and form controls. */
export const THEME_SCHEME: Record<Theme, "light" | "dark"> = {
  ivory: "light",
  paper: "light",
  graphite: "dark",
  voltage: "dark",
  dusk: "dark",
};

export type ThemeOption = {
  id: Theme;
  name: string;
  hint: string;
  /** bg / sunk / ink / brand — literal hexes, see the note in ThemePicker. */
  swatch: readonly [string, string, string, string];
  /** That theme's own corner radius, so the geometry change is visible in the picker. */
  radius: number;
};

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "ivory", name: "Ivory", hint: "warm paper", swatch: ["#F6F3EC", "#EFEBE1", "#1E1B16", "#FFFC00"], radius: 5 },
  { id: "paper", name: "Paper", hint: "cool neutral · squared", swatch: ["#F4F4F5", "#EAEAEC", "#16161A", "#FFFC00"], radius: 2 },
  { id: "graphite", name: "Graphite", hint: "warm dark", swatch: ["#191712", "#211E17", "#F2EEE4", "#FFFC00"], radius: 5 },
  { id: "voltage", name: "Voltage", hint: "the original · default", swatch: ["#050505", "#0B0B0B", "#F4F4F1", "#FFFC00"], radius: 0 },
  { id: "dusk", name: "Dusk", hint: "cool night · soft", swatch: ["#14161F", "#1B1E29", "#ECEEF6", "#FFFC00"], radius: 7 },
];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * The pre-paint guard, stamped into a `beforeInteractive` script in the root
 * layout. Without it every repeat visit paints Ivory and then snaps to the
 * saved theme, which is worse than having no themes at all.
 *
 * Built from the constants above rather than written out by hand, so adding a
 * sixth theme cannot leave the guard rejecting it as unknown.
 *
 * Storage access throws outright in some embedded and hardened-privacy
 * contexts. The right failure is the default theme, not a page that dies
 * before it renders — hence the blanket catch, matching MOTION_GUARD.
 */
export const THEME_GUARD = `(function(){try{
var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}
var ok=${JSON.stringify(THEMES)};
var v=ok.indexOf(t)>-1?t:${JSON.stringify(DEFAULT_THEME)};
var d=document.documentElement;
d.dataset.ozTheme=v;
d.style.colorScheme=${JSON.stringify(THEME_SCHEME)}[v]
}catch(e){document.documentElement.dataset.ozTheme=${JSON.stringify(DEFAULT_THEME)}}})()`;
