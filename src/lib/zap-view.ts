/**
 * Which of the five `/zap` surfaces a URL is asking for.
 *
 * This lived inside UseSurface until the app shell needed the same answer to
 * light the right sidebar item. Two copies of this function is the kind of
 * drift nobody notices for a week: the console renders "Zap now" while the
 * sidebar insists you are on "Start", and both are reading the same URL.
 *
 * The contract is load-bearing and predates the redesign — `?view=`,
 * `?src=build`, `?route=` and `?d=` appear in old bookmarks, in the `/build`
 * and `/app` redirects, and in every share link the builder has ever produced.
 * Add cases; do not change what the existing ones mean.
 */

export type ZapView = "start" | "design" | "sign" | "automate" | "connect";

export const ZAP_VIEWS: readonly ZapView[] = ["start", "design", "sign", "automate", "connect"];

export const DEFAULT_ZAP_VIEW: ZapView = "start";

/** What the URL says the visible view should be, or null when it is silent. */
export function impliedZapView(params: URLSearchParams): ZapView | null {
  // Every explicit `?view=` is answered HERE, above the inference rules below.
  // Order is load-bearing: `?view=connect&src=build` is exactly what the connect
  // handoff produces, and if that fell through to the `src=build` rule it would
  // silently open the sign console instead — no error, just the wrong screen.
  const view = params.get("view");
  if (view === "start") return "start";
  if (view === "sign") return "sign";
  if (view === "design") return "design";
  if (view === "automate") return "automate";
  if (view === "connect") return "connect";
  // A deploy handoff or a deep link to a specific route opens the console; a
  // `?d=` share link opens the canvas it encodes.
  if (params.get("src") === "build" || params.get("route")) return "sign";
  if (params.get("d")) return "design";
  return null;
}

/** The view a URL resolves to once the silent case has fallen back. */
export function resolveZapView(params: URLSearchParams): ZapView {
  return impliedZapView(params) ?? DEFAULT_ZAP_VIEW;
}
