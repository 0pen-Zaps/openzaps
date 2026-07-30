"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

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
const THEME_CHANGE_EVENT = "openzaps:theme-change";

function readThemeSnapshot(): Theme {
  const attr = document.documentElement.dataset.ozTheme;
  return isTheme(attr) ? attr : DEFAULT_THEME;
}

function readServerThemeSnapshot(): Theme {
  return DEFAULT_THEME;
}

function applyThemeToDocument(theme: Theme): void {
  const root = document.documentElement;
  // Write only when something changed. Repeated attribute writes can form a
  // mutation loop with browser extensions that observe the document.
  if (root.dataset.ozTheme !== theme) root.dataset.ozTheme = theme;
  const scheme = THEME_SCHEME[theme];
  if (root.style.colorScheme !== scheme) root.style.colorScheme = scheme;
}

function subscribeToTheme(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyThemeToDocument(isTheme(event.newValue) ? event.newValue : DEFAULT_THEME);
    onChange();
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Holds the picked theme and keeps the document in step with it.
 *
 * The attribute itself is written before React exists, by the THEME_GUARD
 * script in the root layout — this provider's job is only to carry the value
 * for the picker and to keep the document, storage and browser chrome
 * agreeing after a change.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Server rendering and the first hydration render must agree. The pre-paint
  // guard already gives the document its saved colours, but reading that
  // attribute in the state initializer made ThemePicker render (for example)
  // "Ivory" against the server's "Voltage" and triggered React #418.
  //
  // useSyncExternalStore deliberately uses the default server snapshot during
  // hydration, then adopts the guard's DOM value immediately afterward.
  const theme = useSyncExternalStore(subscribeToTheme, readThemeSnapshot, readServerThemeSnapshot);

  const setTheme = useCallback((next: Theme): void => {
    applyThemeToDocument(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (hardened privacy, embedded webview, quota). The
      // choice still applies for this session; only its persistence is lost.
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  useEffect(() => {
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

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeSession {
  return useContext(ThemeContext);
}
