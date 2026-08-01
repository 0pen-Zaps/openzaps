"use client";

import {
  Analytics,
  type BeforeSendEvent,
} from "@vercel/analytics/next";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import {
  captureAnalyticsAttribution,
  claimAnalyticsCampaignArrival,
  trackEvent,
  type AnalyticsPayload,
} from "@/lib/analytics";

type AnalyticsClickDataset = {
  analyticsEvent?: string;
  analyticsCta?: string;
  analyticsContent?: string;
};

export function redactAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  const absolute = /^https?:\/\//u.test(event.url);
  if (!absolute && (!event.url.startsWith("/") || event.url.startsWith("//"))) return null;

  try {
    const url = new URL(event.url, "https://www.0xzaps.com");
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return null;

    const redactedPath = url.pathname
      .split("/")
      .map((segment) => {
        const decoded = decodeURIComponent(segment);
        return /^0x[a-f0-9]{40,64}$/iu.test(decoded) ? "[address]" : segment;
      })
      .join("/");
    const redactedUrl = absolute ? `${url.origin}${redactedPath}` : redactedPath;
    return redactedUrl === event.url ? event : { ...event, url: redactedUrl };
  } catch {
    return null;
  }
}

export function analyticsClickEvent(
  dataset: AnalyticsClickDataset,
): { event: string; payload: AnalyticsPayload } | null {
  if (!dataset.analyticsEvent) return null;
  return {
    event: dataset.analyticsEvent,
    payload: {
      cta: dataset.analyticsCta,
      content: dataset.analyticsContent,
    },
  };
}

export function recordAnalyticsCampaignArrival(search?: string): boolean {
  const attribution = captureAnalyticsAttribution(search);
  if (!attribution || !claimAnalyticsCampaignArrival(attribution)) return false;

  trackEvent("campaign_arrival");
  return true;
}

/**
 * One client island owns both privacy-filtered Vercel pageviews and delegated
 * CTA measurement. Server-rendered links only carry anonymous data labels, so
 * they do not need to become client components themselves.
 */
export function OpenZapsAnalytics(): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => {
    recordAnalyticsCampaignArrival(search);
  }, [pathname, search]);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const marked = event.target.closest<HTMLElement>("[data-analytics-event]");
      if (!marked) return;
      const analyticsEvent = analyticsClickEvent(marked.dataset);
      if (analyticsEvent) trackEvent(analyticsEvent.event, analyticsEvent.payload);
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return <Analytics beforeSend={redactAnalyticsEvent} />;
}
