"use client";

import { useSearchParams } from "next/navigation";

import Console from "./Console";
import AutomateConsole from "./AutomateConsole";
import ConnectConsole from "./ConnectConsole";
import { ZapBuilder } from "./ZapBuilder";
import { DesignHero } from "./DesignHero";
import { ZapLauncher } from "./ZapLauncher";
import { resolveZapView, type ZapView } from "@/lib/zap-view";
import buildStyles from "./build.module.css";

/**
 * The one product surface: design a zap, sign it, or automate it — same page.
 *
 * Four views, one URL. "Start" is the intent-first entry. "Compose" is the
 * visual builder — the block palette, canvas, and readout that used to live at
 * /build. "Zap now" is the policy console that creates, funds, and executes
 * v1.1 zaps. "Automate" is the v3 console: recurring and price-triggered zaps
 * whose cadence/condition the contract enforces, executed by permissionless
 * executors for a 1% fee. The builder's deploy handoff is a same-page switch:
 * it writes the route/amount/bps into the query string exactly as the old
 * cross-page link did (so the console's importer, old bookmarks, and the /build
 * and /app redirects all keep working) and this wrapper flips the visible view
 * to match.
 *
 * The URL remains the single source of truth for the visible view — but the
 * control that changes it moved out. The four-tab strip that used to sit above
 * this is now five destinations in the app shell's sidebar, which is the whole
 * point of the redesign: the steps of a zap are places you can go, not tabs you
 * have to notice. `resolveZapView` lives in @/lib/zap-view so the sidebar
 * highlight and the mounted panel cannot disagree about which one is showing.
 *
 * Only the ACTIVE panel's content is mounted. Each console owns wallet
 * listeners, RPC polling, and localStorage restores in its mount effects;
 * keeping them unmounted while someone drags blocks means none of that runs
 * until it is needed — and mounting fresh on switch is what makes the sign
 * console read the handoff query at the right moment.
 */
export function UseSurface(): React.JSX.Element {
  const searchParams = useSearchParams();
  const view: ZapView = resolveZapView(new URLSearchParams(searchParams.toString()));
  // Passed down (and used as a key) so a client-side navigation carrying a new
  // share token re-seeds the builder instead of showing the stale canvas.
  const shareToken = searchParams.get("d");

  if (view === "design") {
    return (
      <main className={buildStyles.page} id="main">
        <DesignHero />
        <ZapBuilder key={shareToken ?? "local"} shareToken={shareToken} />
      </main>
    );
  }

  if (view === "sign") return <Console />;
  if (view === "automate") return <AutomateConsole key={searchParams.toString()} />;
  // `?agent=` is read here and passed down, so ConnectConsole needs no search-param
  // hook of its own — and therefore no second Suspense boundary.
  if (view === "connect") return <ConnectConsole proposedAgent={searchParams.get("agent")} />;
  return <ZapLauncher />;
}
