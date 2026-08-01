import { describe, expect, it } from "vitest";

import {
  analyticsClickEvent,
  redactAnalyticsEvent,
} from "@/components/OpenZapsAnalytics";

describe("OpenZaps analytics privacy wrapper", () => {
  it("removes request prefill data, query strings, and fragments", () => {
    expect(
      redactAnalyticsEvent({
        type: "pageview",
        url: "https://www.0xzaps.com/request-a-zap?workflow=private&projectUrl=https%3A%2F%2Fexample.com#request-form",
      }),
    ).toEqual({
      type: "pageview",
      url: "https://www.0xzaps.com/request-a-zap",
    });
    expect(
      redactAnalyticsEvent({
        type: "event",
        url: "/zap?view=connect&agent=0x1111111111111111111111111111111111111111",
      }),
    ).toEqual({ type: "event", url: "/zap" });
  });

  it("redacts EVM identifiers embedded in route paths", () => {
    expect(
      redactAnalyticsEvent({
        type: "pageview",
        url: "/explore/0x1111111111111111111111111111111111111111?tab=activity",
      }),
    ).toEqual({ type: "pageview", url: "/explore/[address]" });
    expect(
      redactAnalyticsEvent({
        type: "pageview",
        url: "/explore/0XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toEqual({ type: "pageview", url: "/explore/[address]" });
  });

  it("drops malformed or non-web analytics URLs", () => {
    expect(redactAnalyticsEvent({ type: "pageview", url: "not a URL" })).toBeNull();
    expect(redactAnalyticsEvent({ type: "event", url: "javascript:alert(1)" })).toBeNull();
    expect(redactAnalyticsEvent({ type: "event", url: "//attacker.example/private" })).toBeNull();
    expect(redactAnalyticsEvent({ type: "event", url: "/bad/%E0%A4%A" })).toBeNull();
  });

  it("turns only marked anonymous link labels into click events", () => {
    expect(
      analyticsClickEvent({
        analyticsEvent: "growth_link_clicked",
        analyticsCta: "discord",
        analyticsContent: "site_footer",
      }),
    ).toEqual({
      event: "growth_link_clicked",
      payload: { cta: "discord", content: "site_footer" },
    });
    expect(analyticsClickEvent({ analyticsCta: "discord" })).toBeNull();
  });
});
