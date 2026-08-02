import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("@vercel/analytics", () => ({ track }));

import {
  captureAnalyticsAttribution,
  claimAnalyticsCampaignArrival,
  providerAnalyticsPayload,
  sanitizeAnalyticsPayload,
  trackEvent,
  type AnalyticsPayload,
} from "@/lib/analytics";

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

function stubBrowser(search = ""): { dispatchEvent: ReturnType<typeof vi.fn>; storage: Storage } {
  const dispatchEvent = vi.fn();
  const storage = memoryStorage();
  vi.stubGlobal("window", {
    dispatchEvent,
    location: { pathname: "/request-a-zap", search },
    sessionStorage: storage,
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
  return { dispatchEvent, storage };
}

describe("analytics privacy boundary", () => {
  beforeEach(() => {
    track.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps only bounded, anonymous funnel properties", () => {
    expect(
      sanitizeAnalyticsPayload({
        source: "x",
        medium: "social",
        campaign: "openzaps-virtual-trading-2026-07-30",
        content: "feed_update",
        persona: "agent_builder",
        blocks: 3,
        published: false,
        account: "0x1111111111111111111111111111111111111111",
        tx: `0x${"a".repeat(64)}`,
        contact: "builder@example.com",
        status: Number.NaN,
        unknown: "not-forwarded",
      }),
    ).toEqual({
      source: "x",
      medium: "social",
      campaign: "product_update",
      content: "feed_update",
      persona: "agent_builder",
      blocks: 3,
      published: false,
    });
  });

  it("drops identifiers and secrets even when supplied under an allowed key", () => {
    expect(
      sanitizeAnalyticsPayload({
        route: "0x1111111111111111111111111111111111111111",
        guard: "0XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        campaign: "person@example.com",
        content: "sk-proj-this-is-not-safe-to-forward",
        source: "https://private.example",
        cta: "x".repeat(101),
        mode: " bounded ",
      }),
    ).toEqual({ mode: "bounded" });
  });

  it("drops unowned attribution rather than forwarding arbitrary query text", () => {
    expect(
      sanitizeAnalyticsPayload({
        source: "personal-handle",
        medium: "2125550100",
        campaign: "550e8400-e29b-41d4-a716-446655440000",
        content: "private-note",
        persona: "protocol_team",
      }),
    ).toEqual({ persona: "protocol_team" });
  });

  it("drops nested runtime values even if TypeScript callers are bypassed", () => {
    expect(
      sanitizeAnalyticsPayload({
        mode: { nested: true },
        blocks: [1, 2],
        published: true,
      } as unknown as AnalyticsPayload),
    ).toEqual({ published: true });
  });

  it("forwards at most two properties with a coarse first-touch label", () => {
    const { dispatchEvent } = stubBrowser(
      "?utm_source=discord&utm_medium=community&utm_campaign=openzaps-virtual-trading-2026-07-30&utm_content=feed_update",
    );

    trackEvent("lead_request_submit", {
      persona: "protocol_team",
      source: "discord",
      medium: "community",
      campaign: "openzaps-virtual-trading-2026-07-30",
      content: "feed_update",
    });

    expect(track).toHaveBeenCalledWith("lead_request_submit", {
      acquisition: "discord|community|product_update|feed_update",
      persona: "protocol_team",
    });
    expect(Object.keys(track.mock.calls[0]?.[1] ?? {})).toHaveLength(2);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "openzaps:analytics",
      init: {
        detail: {
          event: "lead_request_submit",
          path: "/request-a-zap",
          payload: {
            acquisition: "discord|community|product_update|feed_update",
            persona: "protocol_team",
            source: "discord",
            medium: "community",
            campaign: "product_update",
            content: "feed_update",
          },
        },
      },
    });
  });

  it("keeps the first safe touch for the tab and never stores raw values", () => {
    const { storage } = stubBrowser();

    expect(
      captureAnalyticsAttribution(
        "?utm_source=x&utm_medium=social&utm_campaign=openzaps-release&utm_content=feed_update",
      ),
    ).toBe("x|social|product_update|feed_update");
    expect(
      captureAnalyticsAttribution(
        "?utm_source=discord&utm_medium=community&utm_campaign=request_a_zap&utm_content=hero",
      ),
    ).toBe("x|social|product_update|feed_update");
    expect(storage.length).toBe(1);
    expect(Array.from({ length: storage.length }, (_, index) => storage.key(index))).not.toContain(
      "openzaps-release",
    );
    expect(claimAnalyticsCampaignArrival("x|social|product_update|feed_update")).toBe(true);
    expect(claimAnalyticsCampaignArrival("x|social|product_update|feed_update")).toBe(false);
    expect(storage.length).toBe(2);
  });

  it("keeps coarse Agent Kit conversion attribution", () => {
    stubBrowser();

    expect(
      captureAnalyticsAttribution(
        "?utm_source=openzaps&utm_medium=website&utm_campaign=openzaps-agent-kit&utm_content=agent_kit",
      ),
    ).toBe("openzaps|website|product_update|agent_kit");
  });

  it("accepts the bounded owned learning-hub attribution", () => {
    stubBrowser();

    expect(
      captureAnalyticsAttribution(
        "?utm_source=openzaps&utm_medium=website&utm_campaign=request_a_zap&utm_content=learn_hub",
      ),
    ).toBe("openzaps|website|request_a_zap|learn_hub");
  });

  it("reduces DeFi Tutorials links to anonymous tutorial attribution", () => {
    stubBrowser();

    expect(
      captureAnalyticsAttribution(
        "?utm_source=substack&utm_medium=email&utm_campaign=defitutorials-paper-trade-first-authority-map&utm_content=virtual_trading",
      ),
    ).toBe("substack|email|tutorial_update|virtual_trading");
  });

  it("records a virtual fill with only its enumerated route and direction", () => {
    const { dispatchEvent } = stubBrowser();

    trackEvent("virtual_trade_filled", {
      route: "robinhood-v4-route-usdg-zaps",
      mode: "buy",
      amount: "1000000000",
      order_id: "paper-private-runtime-id",
    } as unknown as AnalyticsPayload);

    expect(track).toHaveBeenCalledWith("virtual_trade_filled", {
      route: "robinhood-v4-route-usdg-zaps",
      mode: "buy",
    });
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      init: {
        detail: {
          event: "virtual_trade_filled",
          payload: {
            route: "robinhood-v4-route-usdg-zaps",
            mode: "buy",
          },
        },
      },
    });
  });

  it("uses two intentional properties when no acquisition is available", () => {
    expect(
      providerAnalyticsPayload(
        sanitizeAnalyticsPayload({
          status: 503,
          source: "x",
          persona: "protocol_team",
          campaign: "request_a_zap",
        }),
        null,
      ),
    ).toEqual({ status: 503, source: "x" });
  });

  it("does not let provider failures interrupt product flows", () => {
    stubBrowser();
    track.mockImplementationOnce(() => {
      throw new Error("provider unavailable");
    });

    expect(() => trackEvent("builder_preview_run", { blocks: 3 })).not.toThrow();
  });

  it("is a no-op during server rendering", () => {
    vi.stubGlobal("window", undefined);

    trackEvent("builder_preview_run", { blocks: 3 });

    expect(track).not.toHaveBeenCalled();
  });

  it("rejects invalid event names without forwarding them", () => {
    const { dispatchEvent } = stubBrowser();

    trackEvent("Unsafe Event", { source: "x" });

    expect(track).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
