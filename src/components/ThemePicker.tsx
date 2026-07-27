"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Glyph } from "./Glyph";
import { useTheme } from "./ThemeProvider";
import { THEME_OPTIONS, type Theme } from "@/lib/theme";
import styles from "./ThemePicker.module.css";

/**
 * The theme trigger and its popover, for the bottom of the sidebar.
 *
 * The trigger's swatch is built from `var(--bg)/var(--panel)/var(--ink)/var(--zap)`,
 * so it previews whatever is currently applied with no state of its own. Each
 * OPTION's swatch uses literal hexes instead — a `var()` there would resolve
 * against the active theme and paint five identical rows — and carries that
 * theme's own corner radius, so switching from Voltage to Dusk is visible as a
 * change of geometry before you commit to it.
 */
export function ThemePicker(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const active = THEME_OPTIONS.find((option) => option.id === theme) ?? THEME_OPTIONS[0];

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    // Sending focus back to the trigger is what keeps Escape from dumping a
    // keyboard user at the top of the document.
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Move focus into the panel on open so the arrow keys and Tab land somewhere
  // sensible rather than continuing from the trigger through the whole sidebar.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const pick = (next: Theme): void => {
    setTheme(next);
    close(true);
  };

  return (
    <>
      {open ? (
        <>
          {/* A transparent full-viewport plate below the panel. Cheaper and more
              reliable than a document-level pointerdown listener, which has to
              guess whether a click landed inside a portal. */}
          <div className={styles.backdrop} onClick={() => close(false)} aria-hidden />
          <div
            ref={panelRef}
            id={menuId}
            className={styles.panel}
            role="menu"
            aria-label="Select theme"
          >
            <span className={styles.panelLabel}>Select theme</span>
            {THEME_OPTIONS.map((option) => {
              const selected = option.id === theme;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={styles.option}
                  data-selected={selected}
                  onClick={() => pick(option.id)}
                >
                  <span
                    className={styles.optionSwatch}
                    style={{ borderRadius: `${option.radius}px` }}
                    aria-hidden
                  >
                    {option.swatch.map((stop, index) => (
                      <i
                        key={stop + String(index)}
                        style={{ background: stop, flex: index === 3 ? "0 0 8px" : "1" }}
                      />
                    ))}
                  </span>
                  <span className={styles.optionText}>
                    <strong>{option.name}</strong>
                    <span>{option.hint}</span>
                  </span>
                  <Glyph name="tick" className={styles.optionTick} />
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.triggerSwatch} aria-hidden>
          <i style={{ background: "var(--bg)" }} />
          <i style={{ background: "var(--panel)" }} />
          <i style={{ background: "var(--ink)" }} />
          <i style={{ background: "var(--zap)", flex: "0 0 6px" }} />
        </span>
        <span className={styles.triggerLabel}>Theme</span>
        <strong className={styles.triggerValue}>{active.name}</strong>
        <Glyph name={open ? "chevronDown" : "chevronUp"} className={styles.triggerChevron} />
      </button>
    </>
  );
}
