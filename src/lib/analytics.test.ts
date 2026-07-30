import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("@vercel/analytics", () => ({ track }));

import { sanitizeAnalyticsPayload, trackEvent } from "@/lib/analytics";

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
        campaign: "launch-week",
        persona: "agent_builder",
        blocks: 3,
        published: false,
        account: "0x1111111111111111111111111111111111111111",
        tx: `0x${"a".repeat(64)}`,
        contact: "builder@example.com",
        content: "https://example.com/private?email=builder@example.com",
        status: Number.NaN,
        unknown: "not-forwarded",
      }),
    ).toEqual({
      source: "x",
      medium: "social",
      campaign: "launch-week",
      persona: "agent_builder",
      blocks: 3,
      published: false,
    });
  });

  it("drops identifiers and secrets even when supplied under an allowed key", () => {
    expect(
      sanitizeAnalyticsPayload({
        route: "0x1111111111111111111111111111111111111111",
        campaign: "person@example.com",
        content: "sk-proj-this-is-not-safe-to-forward",
        source: "https://private.example",
        cta: "x".repeat(101),
        mode: " bounded ",
      }),
    ).toEqual({ mode: "bounded" });
  });

  it("forwards sanitized events to Vercel and the local event bridge", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent,
      location: { pathname: "/request-a-zap" },
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

    trackEvent("lead_request_submitted", {
      persona: "protocol_team",
      source: "discord",
      account: "0x1111111111111111111111111111111111111111",
    });

    expect(track).toHaveBeenCalledWith("lead_request_submitted", {
      persona: "protocol_team",
      source: "discord",
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "openzaps:analytics",
      init: {
        detail: {
          event: "lead_request_submitted",
          path: "/request-a-zap",
          payload: {
            persona: "protocol_team",
            source: "discord",
          },
        },
      },
    });
  });

  it("rejects invalid event names without forwarding them", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent,
      location: { pathname: "/" },
    });

    trackEvent("Unsafe Event", { source: "x" });

    expect(track).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
