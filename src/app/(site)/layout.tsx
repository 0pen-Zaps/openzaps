import { AppShell } from "@/components/AppShell";

/**
 * Chrome for every interior page.
 *
 * The landing page at `/` runs its own navigation and footer inside the
 * `(landing)` group — and its own token scope — so the app shell mounts here
 * rather than in the root layout. Pages below this point render CONTENT only:
 * no page-level nav, no footer, no full-bleed hero background. The shell owns
 * the viewport, the scroll container and the content measure.
 */
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <AppShell>{children}</AppShell>;
}
