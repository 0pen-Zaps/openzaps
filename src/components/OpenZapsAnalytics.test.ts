import { afterEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("@vercel/analytics", () => ({ track }));

import {
  analyticsClickEvent,
  recordAnalyticsCampaignArrival,
  redactAnalyticsEvent,
} from "@/components/OpenZapsAnalytics";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("OpenZaps analytics privacy wrapper", () => {
  afterEach(() => {
    track.mockReset();
    vi.unstubAllGlobals();
  });

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

  it("records a campaign arrival discovered after client-side navigation once", () => {
    const location = { pathname: "/", search: "" };
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent,
      location,
      sessionStorage: memoryStorage(),
    });
    vi.stubGlobal(
      "CustomEvent",
      class TestCustomEvent {
        constructor(
          public type: string,
          public init: { detail: unknown },
        ) {}
      },
    );

    expect(recordAnalyticsCampaignArrival()).toBe(false);

    location.pathname = "/request-a-zap";
    location.search = "?utm_source=openzaps&utm_medium=website&utm_campaign=request_a_zap&utm_content=learn_hub";

    expect(recordAnalyticsCampaignArrival()).toBe(true);
    expect(recordAnalyticsCampaignArrival()).toBe(false);
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("campaign_arrival", {
      acquisition: "openzaps|website|request_a_zap|learn_hub",
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
