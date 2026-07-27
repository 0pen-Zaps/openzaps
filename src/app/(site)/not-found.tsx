import type { Metadata } from "next";
import { RouteNotFound } from "@/components/RouteNotFound";
import styles from "@/app/status.module.css";

export const metadata: Metadata = {
  title: "Not found",
  description: "That address or page is not in OpenZaps. Jump back to Zap, Explore, or the docs.",
  robots: { index: false, follow: true },
};

/**
 * 404 inside the app, so the shell survives it.
 *
 * The route that needs this most is `/explore/<address>`, which calls
 * `notFound()` for an address the factory never deployed. Without a not-found in
 * this group, Next walks up to the root one — which renders on the bare layout —
 * and someone who mistyped a single character in an address loses the sidebar,
 * the wallet chip and every route out. The AppShell above this keeps all of it.
 */
export default function SiteNotFound(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <RouteNotFound />
    </main>
  );
}
