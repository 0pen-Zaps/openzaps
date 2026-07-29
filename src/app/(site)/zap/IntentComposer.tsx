"use client";

import { useId, useState } from "react";

import styles from "./intent-composer.module.css";

type ComposeResult =
  | {
      ok: true;
      plan: { token: string; handoff: { href: string } | null };
      rationale: string;
      model: string;
    }
  | { ok: false; refusal?: { reason: string; issues: string[] }; error?: string };

export function IntentComposer({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const inputId = useId();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (): Promise<void> => {
    const intent = prompt.trim();
    if (!intent || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/agent/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: intent }),
      });
      const body = (await response.json()) as ComposeResult;
      if (!body.ok) {
        const refusal = body.refusal;
        setMessage(
          refusal
            ? [refusal.reason, ...refusal.issues].join(" ")
            : body.error ?? "That intent could not be composed.",
        );
        return;
      }

      setMessage(
        body.model === "deterministic-catalog"
          ? "Matched a reviewed blueprint locally. Opening the compiled design…"
          : "Compiled against the block catalog. Opening the design…",
      );
      // The composer and the builder are two query-driven views of the same
      // Next route. A client router transition can leave the Suspense-backed
      // Start view mounted even after the compose request succeeds. Rebuilding
      // the page from the compiler's validated token makes the URL and visible
      // design change together, and avoids trusting a response-provided href.
      window.location.assign(`/zap?view=design&d=${encodeURIComponent(body.plan.token)}`);
    } catch {
      setMessage("The composer could not be reached. The reviewed blueprints below still work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.shell} data-compact={compact} aria-labelledby={`${inputId}-title`}>
      <div className={styles.copy}>
        <span className={styles.eyebrow}>DESCRIBE YOUR ZAP</span>
        <h2 id={`${inputId}-title`}>Say the outcome in plain language.</h2>
        <p>
          A model may propose the blocks; the deterministic catalog and compiler decide what survives.
          No wallet action happens here.
        </p>
      </div>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="srOnly" htmlFor={inputId}>
          Describe the Zap you want to build
        </label>
        <div className={styles.control}>
          <input
            id={inputId}
            type="text"
            value={prompt}
            maxLength={1000}
            placeholder="e.g. Redeem ozUSDG back to USDG"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button type="submit" disabled={!prompt.trim() || busy} data-busy={busy}>
            {busy ? "Compiling…" : "Compose →"}
          </button>
        </div>
        <p className={styles.examples}>Try: “DCA weekly” · “Buy 0xZAPS with USDG” · “Exit liquidity to aeWETH”</p>
        <p className={styles.status} aria-live="polite">
          {message}
        </p>
      </form>
    </section>
  );
}
