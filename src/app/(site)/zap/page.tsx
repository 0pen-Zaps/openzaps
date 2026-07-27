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
    // `idScope` because both this fallback and UseSurface's own default view end
    // up in the streamed markup; without it the two Start screens hand the same
    // id to two headings. See the note on ZapLauncher.
    <Suspense fallback={<ZapLauncher idScope="zap-prerender" />}>
      <UseSurface />
    </Suspense>
  );
}
