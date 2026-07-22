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

  // Without these the preview inherits the root layout's canonical (`/`) and
  // its Open Graph card, so pasting a preview link into Slack or a DM unfurls
  // as the production home page — the reviewer clicks expecting the new
  // identity and gets a card for the old one. Overriding here covers every
  // page in the preview at once.
  alternates: { canonical: null },
  openGraph: {
    title: "OpenZaps — LINES identity preview",
    description: "An alternative OpenZaps identity: one accent, ruled layout, and a bolt drawn entirely out of lines.",
    type: "website",
    locale: "en_US",
    // Deliberately no image. The production card art belongs to the current
    // identity, and shipping it here would misrepresent what the link opens;
    // no card art is more honest than the wrong card art.
    images: [],
  },
  twitter: {
    card: "summary",
    title: "OpenZaps — LINES identity preview",
    description: "An alternative OpenZaps identity, drawn entirely out of lines.",
    images: [],
  },
};

export default function LinesLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className={styles.root}>{children}</div>;
}
