import type { Metadata } from "next";
import Link from "next/link";
import { OpenZapMark } from "@/components/OpenZapMark";
import styles from "./status.module.css";

export const metadata: Metadata = {
  title: "Page not found",
  description: "That OpenZaps route does not exist. Jump back to the console, the Zaps Feed, or the docs.",
  robots: { index: false, follow: true },
};

const SUGGESTIONS = [
  { href: "/app", label: "Policy console" },
  { href: "/zaps", label: "Zaps Feed" },
  { href: "/docs", label: "Docs" },
  { href: "/docs#security", label: "Security" },
  { href: "/token", label: "Tokenomics" },
  { href: "/roadmap", label: "Roadmap" },
] as const;

export default function NotFound(): React.JSX.Element {
  return (
    <main className={`container ${styles.page}`} id="main">
      <div className={styles.inner}>
        <OpenZapMark className={styles.mark} />
        <span className={styles.code}>404</span>
        <h1 className={styles.title}>This route was never in the policy.</h1>
        <p className={styles.body}>
          The page you asked for does not exist. Nothing failed and nothing was executed. The address has no
          capsule behind it.
        </p>
        <div className={styles.actions}>
          <Link href="/" className="btn btnPrimary btnLg">
            <span>Back to home</span>
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
    </main>
  );
}
