import { Suspense } from "react";

import { DesignHero } from "./DesignHero";
import { UseSurface } from "./UseSurface";
import buildStyles from "./build.module.css";

/**
 * /use — the whole product on one page: the visual builder ("Design") and the
 * signing console ("Sign & run"), switched client-side. Metadata and JSON-LD
 * live in ./layout.tsx. The Suspense boundary is what Next requires around
 * useSearchParams in the client wrapper — and its fallback is the real Design
 * hero, so the statically prerendered shell carries the page's h1 and intro
 * instead of a blank frame.
 */
export default function UsePage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <main className={buildStyles.page} id="main">
          <DesignHero />
        </main>
      }
    >
      <UseSurface />
    </Suspense>
  );
}
