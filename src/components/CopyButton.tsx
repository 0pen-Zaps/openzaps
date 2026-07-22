"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./CopyButton.module.css";

type Status = "idle" | "copied" | "failed";

/**
 * Copy-to-clipboard with a self-clearing confirmation.
 *
 * The label swaps rather than showing a transient toast so the feedback lands
 * exactly where the user's attention already is, and `aria-live` announces the
 * result for anyone who cannot see the swap.
 */
export function CopyButton({
  value,
  label,
  title,
  className = "",
}: {
  value: string;
  /** Visible text; defaults to the value itself (useful for addresses). */
  label?: string;
  title?: string;
  className?: string;
}): React.JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      // Clipboard access is denied in some embedded/insecure contexts; say so
      // rather than silently pretending the copy worked.
      setStatus("failed");
    }
    timer.current = window.setTimeout(() => setStatus("idle"), 1800);
  }, [value]);

  return (
    <button
      className={`${styles.copy} ${className}`.trim()}
      data-status={status}
      onClick={() => void copy()}
      title={title ?? `Copy ${value}`}
      type="button"
    >
      <span className={styles.label}>{label ?? value}</span>
      <span aria-hidden className={styles.icon}>
        {status === "copied" ? "✓" : status === "failed" ? "!" : "⧉"}
      </span>
      <span className={styles.sr} role="status">
        {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
