"use client";

import Link from "next/link";
import { useEffect } from "react";
import { OpenZapMark } from "@/components/OpenZapMark";
import styles from "./status.module.css";

export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  // Next 16.2+: prefer `unstable_retry` over `reset`. This app's failures are
  // RPC/onchain fetches, and `reset` only re-renders — it would replay the same
  // error. `unstable_retry` re-fetches the boundary's children first.
  unstable_retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    // Surface the real cause in the browser console; the visible copy stays
    // non-technical but the digest is shown so a report can be correlated.
    console.error("OpenZaps route error", error);
  }, [error]);

  return (
    <main className={`container ${styles.page}`} id="main">
      <div className={styles.inner}>
        <OpenZapMark className={styles.mark} />
        <span className={styles.code}>500</span>
        <h1 className={styles.title}>This page failed to render.</h1>
        <p className={styles.body}>
          Something broke while building this view. No onchain action was taken and no signature was requested —
          a render failure cannot move funds. Retry, or head back and try another route.
        </p>
        {error.digest && (
          <p className={styles.detail}>
            Error digest: {error.digest}
          </p>
        )}
        <div className={styles.actions}>
          <button className="btn btnPrimary btnLg" onClick={() => unstable_retry()} type="button">
            <span>Try again</span>
          </button>
          <Link href="/" className="btn btnGhost btnLg">
            <span>Back to home</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
