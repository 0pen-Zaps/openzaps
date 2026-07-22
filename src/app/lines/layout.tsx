import type { Metadata } from "next";
import styles from "./lines.module.css";

/**
 * Shell shared by every page in the LINES preview.
 *
 * The nav is rendered by each page rather than here so it can mark its own
 * route as current — a layout cannot read the pathname without becoming a
 * client component, and turning the entire preview shell into client-rendered
 * markup to highlight one link would be a poor trade.
 */
export const metadata: Metadata = {
  // Every page in the preview inherits this. A design preview must never
  // compete with the real pages in search: it duplicates their copy verbatim.
  robots: { index: false, follow: false },
};

export default function LinesLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className={styles.root}>{children}</div>;
}
