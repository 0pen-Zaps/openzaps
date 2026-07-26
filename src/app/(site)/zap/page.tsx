import { Suspense } from "react";

import { UseSurface } from "./UseSurface";
import { ZapLauncher } from "./ZapLauncher";

/**
 * /zap — the whole product on one page: intent launcher, visual composer,
 * one-time console, and automation console, switched client-side. Metadata and JSON-LD
 * live in ./layout.tsx. The Suspense boundary is what Next requires around
 * useSearchParams in the client wrapper — and its fallback is the real intent
 * launcher, so the statically prerendered shell carries the page's h1 and choices
 * instead of a blank frame.
 */
export default function UsePage(): React.JSX.Element {
  return (
    <Suspense
      fallback={<ZapLauncher />}
    >
      <UseSurface />
    </Suspense>
  );
}
