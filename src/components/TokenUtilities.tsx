"use client";

import { useRef, useState } from "react";

import {
  ROBINHOOD_ASSETS,
  ensureRobinhoodChain,
  getInjectedProvider,
  watchZapsAsset,
} from "@/lib/robinhood";
import styles from "./TokenUtilities.module.css";

type Action = "copy" | "watch" | null;

export function TokenUtilities(): React.JSX.Element {
  const [busy, setBusy] = useState<Action>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const copyRef = useRef<HTMLButtonElement>(null);
  const watchRef = useRef<HTMLButtonElement>(null);

  async function copyAddress(): Promise<void> {
    setBusy("copy");
    setMessage("");
    setError("");
    try {
      await navigator.clipboard.writeText(ROBINHOOD_ASSETS.zaps);
      setMessage("Official 0xZAPS contract address copied.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the address above.");
    } finally {
      setBusy(null);
      restoreFocus(copyRef.current);
    }
  }

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
      setMessage(added ? "0xZAPS was added to your wallet." : "Wallet closed the add-token request.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      restoreFocus(watchRef.current);
    }
  }

  return (
    <div className={styles.tools}>
      <div className={styles.actions}>
        <button className="btn btnGhost" disabled={busy !== null} onClick={() => void copyAddress()} ref={copyRef} type="button">
          {busy === "copy" ? "Copying…" : "Copy address"}
        </button>
        <button className="btn btnPrimary" disabled={busy !== null} onClick={() => void addToWallet()} ref={watchRef} type="button">
          {busy === "watch" ? "Opening wallet…" : "Add 0xZAPS to wallet"}
        </button>
      </div>
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
