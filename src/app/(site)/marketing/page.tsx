import type { Metadata } from "next";

import { MarketingOperator } from "./MarketingOperator";
import styles from "./marketing.module.css";

export const metadata: Metadata = {
  title: "Marketing operator",
  description: "Private OpenZaps marketing-agent review and publishing controls.",
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function MarketingPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main" data-screen-label="Marketing operator">
      <header className={styles.header}>
        <span className={styles.eyebrow}>Private operator surface</span>
        <h1>Turn verified OpenZaps work into reviewable updates.</h1>
        <p>
          Draft from an explicit brief, inspect the evidence and policy gates,
          then approve or reject the run. The operator credential stays in this
          browser tab&apos;s session storage and is sent only as a bearer header.
        </p>
      </header>

      <MarketingOperator />
    </main>
  );
}
