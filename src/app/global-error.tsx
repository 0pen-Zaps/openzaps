"use client";

import { useEffect } from "react";
import "./globals.css";
import styles from "./status.module.css";

/**
 * Replaces the root layout when the layout itself throws, so it must render its
 * own <html>/<body> and pull in global styles. Metadata exports are unsupported
 * here (it is a Client Component) — React's <title> is the documented substitute.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error("OpenZaps global error", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <title>Something went wrong | OpenZaps</title>
        <main className={`container ${styles.page}`}>
          <div className={styles.inner}>
            <span className={styles.code}>500</span>
            <h1 className={styles.title}>OpenZaps failed to load.</h1>
            <p className={styles.body}>
              The application shell itself crashed. Nothing was signed and nothing was submitted onchain.
            </p>
            {error.digest && <p className={styles.detail}>Error digest: {error.digest}</p>}
            <div className={styles.actions}>
              <button className="btn btnPrimary btnLg" onClick={() => unstable_retry()} type="button">
                <span>Try again</span>
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                  global-error replaces the root layout, so the router shell is
                  the thing that just crashed. A hard navigation rebuilds it;
                  a client-side <Link> would re-enter the broken tree. */}
              <a className="btn btnGhost btnLg" href="/">
                <span>Back to home</span>
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
