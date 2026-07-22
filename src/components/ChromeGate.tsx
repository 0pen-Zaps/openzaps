"use client";

import { usePathname } from "next/navigation";

/**
 * Routes that render their own complete page furniture and must not be wrapped
 * in the production nav and footer.
 *
 * Today that is only the LINES identity preview, whose entire point is to be
 * judged without the current site's chrome framing it.
 */
const STANDALONE = ["/lines"] as const;

/**
 * Hides shared chrome on standalone routes.
 *
 * A client component so it can read the pathname, but its children stay server
 * components — they are rendered on the server and passed through as an opaque
 * subtree, so gating the nav and footer this way costs no extra client
 * JavaScript beyond this one comparison.
 */
export function ChromeGate({ children }: { children: React.ReactNode }): React.ReactNode {
  const pathname = usePathname();
  const standalone = STANDALONE.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  return standalone ? null : children;
}
