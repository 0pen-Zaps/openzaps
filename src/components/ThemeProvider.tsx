"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import {
  DEFAULT_THEME,
  THEME_BG,
  THEME_SCHEME,
  THEME_STORAGE_KEY,
  isTheme,
  type Theme,
} from "@/lib/theme";

type ThemeSession = { theme: Theme; setTheme: (next: Theme) => void };

const ThemeContext = createContext<ThemeSession>({ theme: DEFAULT_THEME, setTheme: () => {} });

/**
 * Holds the picked theme and keeps the document in step with it.
 *
 * The attribute itself is written before React exists, by the THEME_GUARD
 * script in the root layout — this provider's job is only to carry the value
 * for the picker and to keep the document, storage and browser chrome
 * agreeing after a change.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Seeded from the DOM, which the guard has already stamped — never from
  // storage here. Reading storage would give the right answer at the wrong
  // moment: the first client render would disagree with the painted attribute
  // on any visit where the two could differ.
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === "undefined") return DEFAULT_THEME;
    const attr = document.documentElement.dataset.ozTheme;
    return isTheme(attr) ? attr : DEFAULT_THEME;
  });

  const setTheme = useCallback((next: Theme): void => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (hardened privacy, embedded webview, quota). The
      // choice still applies for this session; only its persistence is lost.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // Write only when it actually changes. Setting an attribute on every
    // render is how you end up with a mutation loop against anything
    // observing the document — including the wallet extensions that inject
    // into this page.
    if (root.dataset.ozTheme !== theme) root.dataset.ozTheme = theme;

    const scheme = THEME_SCHEME[theme];
    if (root.style.colorScheme !== scheme) root.style.colorScheme = scheme;

    // The static `viewport.themeColor` in the root layout can only advertise
    // one colour per media query; it cannot know which of five themes was
    // picked. Tracking the real choice means writing the tag here.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = THEME_BG[theme];
  }, [theme]);

  // Another tab switched themes. Following it keeps two open windows from
  // disagreeing about what the app looks like.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      const next = event.newValue;
      if (isTheme(next)) setThemeState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeSession {
  return useContext(ThemeContext);
}
