export type AnalyticsPayload = Record<string, string | number | boolean | null | undefined>;

export function trackEvent(event: string, payload: AnalyticsPayload = {}): void {
  if (typeof window === "undefined") return;

  const detail = {
    event,
    payload,
    ts: new Date().toISOString(),
    path: window.location.pathname,
  };

  window.dispatchEvent(new CustomEvent("openzaps:analytics", { detail }));

  if (process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "1") {
    console.info("[openzaps:analytics]", detail);
  }
}
