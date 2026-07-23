"use client";

import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import Console from "./Console";
import { ZapBuilder } from "./ZapBuilder";
import { DesignHero } from "./DesignHero";
import buildStyles from "./build.module.css";
import appStyles from "./app.module.css";

/**
 * The one product surface: design a zap and sign it, same page.
 *
 * Two views, one URL. "Design" is the visual builder — the block palette,
 * canvas, and readout that used to live at /build. "Sign & run" is the policy
 * console that creates, funds, and executes capsules. The builder's deploy
 * handoff is now a same-page switch: it writes the route/amount/bps into the
 * query string exactly as the old cross-page link did (so the console's
 * importer, old bookmarks, and the /build and /app redirects all keep
 * working) and this wrapper flips the visible view to match.
 *
 * The URL is the single source of truth for the visible view. Tab clicks
 * `router.replace` the `view` param (no history entry per click — Back leaves
 * /use, it does not replay tab flips), while the builder's handoff `Link`
 * pushes, so Back from a handoff returns to the Design canvas.
 *
 * Both tabpanel wrappers stay in the DOM (so each tab's `aria-controls` always
 * points at a real element) but only the ACTIVE panel's content is mounted.
 * The console owns wallet listeners, RPC polling, and localStorage restores in
 * its mount effects; keeping it unmounted while someone drags blocks means
 * none of that runs until it is needed — and mounting it fresh on switch is
 * what makes it read the handoff query at the right moment.
 */

type View = "design" | "sign";

/** What the URL says the visible view should be, or null when it is silent. */
function impliedView(params: URLSearchParams): View | null {
  const view = params.get("view");
  if (view === "sign") return "sign";
  if (view === "design") return "design";
  // A deploy handoff or a deep link to a specific route opens the console; a
  // `?d=` share link opens the canvas it encodes.
  if (params.get("src") === "build" || params.get("route")) return "sign";
  if (params.get("d")) return "design";
  return null;
}

export function UseSurface(): React.JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const designTabRef = useRef<HTMLButtonElement>(null);
  const signTabRef = useRef<HTMLButtonElement>(null);

  const view: View = impliedView(new URLSearchParams(searchParams.toString())) ?? "design";

  const select = (next: View): void => {
    if (next === view) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("view", next);
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  };

  /** The WAI-ARIA tabs pattern: arrows move AND activate, Home/End jump. */
  const onTablistKeyDown = (event: React.KeyboardEvent): void => {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End"
        ? "sign"
        : event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home"
          ? "design"
          : null;
    if (!next) return;
    event.preventDefault();
    (next === "design" ? designTabRef : signTabRef).current?.focus();
    select(next);
  };

  return (
    <div>
      <div className="container" style={{ paddingTop: "1.1rem" }}>
        <div
          className={`${appStyles.segment} ${buildStyles.useTabs}`}
          role="tablist"
          aria-label="Use OpenZaps"
          onKeyDown={onTablistKeyDown}
        >
          <button
            ref={designTabRef}
            type="button"
            role="tab"
            id="use-tab-design"
            aria-selected={view === "design"}
            aria-controls="use-panel-design"
            tabIndex={view === "design" ? 0 : -1}
            className={view === "design" ? appStyles.segOn : appStyles.seg}
            onClick={() => select("design")}
          >
            Design
            <em>drag blocks into a zap</em>
          </button>
          <button
            ref={signTabRef}
            type="button"
            role="tab"
            id="use-tab-sign"
            aria-selected={view === "sign"}
            aria-controls="use-panel-sign"
            tabIndex={view === "sign" ? 0 : -1}
            className={view === "sign" ? appStyles.segOn : appStyles.seg}
            onClick={() => select("sign")}
          >
            Sign &amp; run
            <em>create, fund, execute</em>
          </button>
        </div>
      </div>

      <div
        id="use-panel-design"
        role="tabpanel"
        aria-labelledby="use-tab-design"
        hidden={view !== "design"}
      >
        {view === "design" ? (
          <main className={buildStyles.page} id="main">
            <DesignHero />
            <div className="container">
              <ZapBuilder />
            </div>
          </main>
        ) : null}
      </div>
      <div
        id="use-panel-sign"
        role="tabpanel"
        aria-labelledby="use-tab-sign"
        hidden={view !== "sign"}
      >
        {view === "sign" ? <Console /> : null}
      </div>
    </div>
  );
}
