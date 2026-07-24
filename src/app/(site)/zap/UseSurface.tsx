"use client";

import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import Console from "./Console";
import AutomateConsole from "./AutomateConsole";
import { ZapBuilder } from "./ZapBuilder";
import { DesignHero } from "./DesignHero";
import buildStyles from "./build.module.css";
import appStyles from "./app.module.css";

/**
 * The one product surface: design a zap, sign it, or automate it — same page.
 *
 * Three views, one URL. "Design" is the visual builder — the block palette,
 * canvas, and readout that used to live at /build. "Sign & run" is the policy
 * console that creates, funds, and executes v1.1 capsules. "Automate" is the
 * v3 console: recurring and price-triggered capsules whose cadence/condition
 * the contract enforces, executed by permissionless executors for a 1% fee.
 * The builder's deploy handoff is a same-page switch: it writes the
 * route/amount/bps into the query string exactly as the old cross-page link
 * did (so the console's importer, old bookmarks, and the /build and /app
 * redirects all keep working) and this wrapper flips the visible view to
 * match.
 *
 * The URL is the single source of truth for the visible view. Tab clicks
 * `router.replace` the `view` param (no history entry per click — Back leaves
 * /zap, it does not replay tab flips), while the builder's handoff `Link`
 * pushes, so Back from a handoff returns to the Design canvas.
 *
 * All tabpanel wrappers stay in the DOM (so each tab's `aria-controls` always
 * points at a real element) but only the ACTIVE panel's content is mounted.
 * Each console owns wallet listeners, RPC polling, and localStorage restores
 * in its mount effects; keeping them unmounted while someone drags blocks
 * means none of that runs until it is needed — and mounting fresh on switch
 * is what makes the sign console read the handoff query at the right moment.
 */

type View = "design" | "sign" | "automate";

const VIEW_ORDER: readonly View[] = ["design", "sign", "automate"];

/** What the URL says the visible view should be, or null when it is silent. */
function impliedView(params: URLSearchParams): View | null {
  const view = params.get("view");
  if (view === "sign") return "sign";
  if (view === "design") return "design";
  if (view === "automate") return "automate";
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
  const automateTabRef = useRef<HTMLButtonElement>(null);
  const tabRefs: Record<View, React.RefObject<HTMLButtonElement | null>> = {
    design: designTabRef,
    sign: signTabRef,
    automate: automateTabRef,
  };

  const view: View = impliedView(new URLSearchParams(searchParams.toString())) ?? "design";
  // Passed down (and used as a key) so a client-side navigation carrying a new
  // share token re-seeds the builder instead of showing the stale canvas.
  const shareToken = searchParams.get("d");

  const select = (next: View): void => {
    if (next === view) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("view", next);
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  };

  /** The WAI-ARIA tabs pattern: arrows move AND activate, Home/End jump. */
  const onTablistKeyDown = (event: React.KeyboardEvent): void => {
    const index = VIEW_ORDER.indexOf(view);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? VIEW_ORDER[Math.min(index + 1, VIEW_ORDER.length - 1)]
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? VIEW_ORDER[Math.max(index - 1, 0)]
          : event.key === "Home"
            ? VIEW_ORDER[0]
            : event.key === "End"
              ? VIEW_ORDER[VIEW_ORDER.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    tabRefs[next].current?.focus();
    select(next);
  };

  return (
    <div>
      <div className="container" style={{ paddingTop: "1.1rem" }}>
        <div
          className={`${appStyles.segment} ${buildStyles.useTabs}`}
          role="tablist"
          aria-label="Zap workspace"
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
          <button
            ref={automateTabRef}
            type="button"
            role="tab"
            id="use-tab-automate"
            aria-selected={view === "automate"}
            aria-controls="use-panel-automate"
            tabIndex={view === "automate" ? 0 : -1}
            className={view === "automate" ? appStyles.segOn : appStyles.seg}
            onClick={() => select("automate")}
          >
            Automate
            <em>recurring &amp; price triggers</em>
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
              <ZapBuilder key={shareToken ?? "local"} shareToken={shareToken} />
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
      <div
        id="use-panel-automate"
        role="tabpanel"
        aria-labelledby="use-tab-automate"
        hidden={view !== "automate"}
      >
        {view === "automate" ? <AutomateConsole /> : null}
      </div>
    </div>
  );
}
