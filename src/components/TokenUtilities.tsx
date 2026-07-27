"use client";

import { useRef, useState } from "react";

import { ensureRobinhoodChain, getInjectedProvider, watchZapsAsset } from "@/lib/robinhood";
import styles from "./TokenUtilities.module.css";

type Action = "watch" | null;

/**
 * The add-to-wallet control, plus the two live regions that report what the
 * wallet actually did.
 *
 * Copying the address is deliberately NOT here any more: the contract row on
 * /token carries a `CopyButton`, and two copy affordances for the same string
 * is how someone ends up copying from the one that failed silently.
 *
 * `className` styles the button itself so the caller owns its geometry — the
 * control is rendered inside a rail card, not in a standalone action row.
 */
export function TokenUtilities({ className = "" }: { className?: string }): React.JSX.Element {
  const [busy, setBusy] = useState<Action>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const watchRef = useRef<HTMLButtonElement>(null);

  async function addToWallet(): Promise<void> {
    setBusy("watch");
    setMessage("");
    setError("");
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found. Open this page in a wallet-enabled browser.");
      await ensureRobinhoodChain(provider);
      const image = new URL("/0xzaps-token.png", window.location.origin).href;
      const added = await watchZapsAsset(provider, image);
      // A user decline REJECTS the request and lands in the catch below, so a
      // non-true result is a wallet that acknowledged nothing — not a decline.
      setMessage(added ? "0xZAPS was added to your wallet." : "Wallet did not confirm the add. Check your token list.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      restoreFocus(watchRef.current);
    }
  }

  return (
    <div className={styles.tools}>
      <button
        className={className}
        data-busy={busy === "watch" ? "true" : undefined}
        disabled={busy !== null}
        onClick={() => void addToWallet()}
        ref={watchRef}
        type="button"
      >
        {busy === "watch" ? "Opening wallet…" : "Add to wallet"}
      </button>
      <p className={styles.success} role="status">{message}</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

// The disabled attribute drops keyboard focus to <body> while an action is in
// flight; return focus to the initiating control once it re-enables.
function restoreFocus(button: HTMLButtonElement | null): void {
  window.setTimeout(() => {
    if (document.activeElement === document.body) button?.focus();
  }, 0);
}

function readableError(cause: unknown): string {
  if (!(cause instanceof Error)) return "Wallet request failed.";
  return cause.message.split("\n")[0].replace("User rejected the request.", "Wallet request rejected.");
}
