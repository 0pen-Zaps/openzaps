import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * Chrome for every interior page. The landing page at `/` runs its own
 * navigation and footer inside the `(landing)` group, so the shared nav and
 * footer mount here instead of in the root layout.
 */
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <>
      <SiteNav />
      {children}
      <SiteFooter />
    </>
  );
}
