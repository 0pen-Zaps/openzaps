import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  THEMES,
  THEME_BG,
  THEME_GUARD,
  THEME_OPTIONS,
  THEME_SCHEME,
  THEME_STORAGE_KEY,
  isTheme,
} from "./theme";

describe("isTheme", () => {
  it("accepts every declared theme", () => {
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
  });

  it("rejects anything else, including the shapes localStorage can hand back", () => {
    for (const value of ["", "IVORY", "sepia", null, undefined, 0, {}, ["ivory"]]) {
      expect(isTheme(value)).toBe(false);
    }
  });
});

describe("theme tables", () => {
  it("covers every theme in every lookup", () => {
    for (const theme of THEMES) {
      expect(THEME_BG[theme]).toMatch(/^#[0-9A-F]{6}$/);
      expect(["light", "dark"]).toContain(THEME_SCHEME[theme]);
    }
  });

  it("offers every theme in the picker, in a stable order", () => {
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual([...THEMES]);
  });

  it("gives each picker option a four-stop literal swatch", () => {
    // Literal, never var(): a var() here would paint the CURRENT theme five
    // times over and the picker would show five identical rows.
    for (const option of THEME_OPTIONS) {
      expect(option.swatch).toHaveLength(4);
      for (const stop of option.swatch) expect(stop).toMatch(/^#[0-9A-F]{6}$/);
      expect(option.swatch[0]).toBe(THEME_BG[option.id]);
    }
  });

  it("keeps Voltage at zero radius — it is the squared identity", () => {
    expect(THEME_OPTIONS.find((o) => o.id === "voltage")?.radius).toBe(0);
  });
});

describe("THEME_GUARD", () => {
  /**
   * Run the guard the way the browser will: as a source string, against a stub
   * document and localStorage. Executing it is the whole point — the guard is
   * the one piece of this system that never goes through the type checker.
   */
  function runGuard(stored: string | null, storageThrows = false): { theme?: string; scheme: string } {
    const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
    runInNewContext(THEME_GUARD, {
      document: { documentElement },
      localStorage: {
        getItem: (): string | null => {
          if (storageThrows) throw new Error("storage is blocked");
          return stored;
        },
      },
    });
    return { theme: documentElement.dataset.ozTheme, scheme: documentElement.style.colorScheme };
  }

  it("restores a saved theme before paint", () => {
    expect(runGuard("graphite")).toEqual({ theme: "graphite", scheme: "dark" });
    expect(runGuard("voltage")).toEqual({ theme: "voltage", scheme: "dark" });
    expect(runGuard("paper")).toEqual({ theme: "paper", scheme: "light" });
  });

  it("falls back to the default for an empty, unknown or tampered value", () => {
    expect(runGuard(null).theme).toBe(DEFAULT_THEME);
    expect(runGuard("sepia").theme).toBe(DEFAULT_THEME);
    expect(runGuard("__proto__").theme).toBe(DEFAULT_THEME);
  });

  it("survives storage that throws rather than returning null", () => {
    // Hardened-privacy and some embedded contexts throw on access. The page
    // must still render; the cost of getting this wrong is a blank site.
    expect(runGuard(null, true).theme).toBe(DEFAULT_THEME);
  });

  it("reads the same storage key the provider writes", () => {
    expect(THEME_GUARD).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("knows every theme, so a new one cannot be rejected as unknown", () => {
    for (const theme of THEMES) expect(runGuard(theme).theme).toBe(theme);
  });
});
