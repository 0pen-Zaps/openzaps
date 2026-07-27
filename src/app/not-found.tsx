import type { Metadata } from "next";
import { RouteNotFound } from "@/components/RouteNotFound";
import styles from "./status.module.css";

export const metadata: Metadata = {
  title: "Page not found",
  description: "That OpenZaps route does not exist. Jump back to Zap, Explore, or the docs.",
  robots: { index: false, follow: true },
};

/**
 * 404 for anything outside the app: the bare root layout, no sidebar.
 * `(site)/not-found.tsx` handles misses inside the app, where the shell stays.
 */
export default function NotFound(): React.JSX.Element {
  return (
    <main className={`container ${styles.page}`} id="main">
      <RouteNotFound />
    </main>
  );
}
