import Link from "next/link";

import { OpenZapMark } from "@/components/OpenZapMark";
import { TOKEN } from "@/lib/config";
import styles from "@/app/status.module.css";

/**
 * The body of a 404, rendered by two route files.
 *
 * `src/app/not-found.tsx` catches misses outside the app and renders this on the
 * bare root layout. `src/app/(site)/not-found.tsx` catches misses inside it —
 * including the `notFound()` an unverified address triggers on
 * `/explore/<address>` — and gets the app shell around it, so a wrong address
 * does not strand someone on a page with no navigation. One body, so the two can
 * never drift into telling different stories about the same failure.
 */

/** Where to send someone instead. Mirrors the shell's sidebar, in its order. */
const SUGGESTIONS = [
  { href: "/zap?view=start", label: "Start a zap" },
  { href: "/zapdraw", label: "ZapDraw" },
  { href: "/profile", label: "My zaps" },
  { href: "/explore", label: "Explore" },
  { href: "/pot", label: "Pot" },
  { href: "/docs", label: "Docs" },
  { href: "/docs#security", label: "Security model" },
  { href: "/token", label: TOKEN.symbol },
] as const;

export function RouteNotFound(): React.JSX.Element {
  return (
    <div className={styles.inner}>
      <OpenZapMark className={styles.mark} />
      <span className={styles.code}>404</span>
      <h1 className={styles.title}>This route was never in the policy.</h1>
      <p className={styles.body}>
        The page you asked for does not exist. Nothing failed and nothing was executed — there is no Zap behind this
        address.
      </p>
      <div className={styles.actions}>
        <Link href="/zap?view=start" className="btn btnPrimary btnLg">
          <span>Start a zap</span>
        </Link>
        <Link href="/docs" className="btn btnGhost btnLg">
          <span>Read the docs</span>
        </Link>
      </div>
      <div className={styles.suggest}>
        {SUGGESTIONS.map((item) => (
          <Link href={item.href} key={item.href}>
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
