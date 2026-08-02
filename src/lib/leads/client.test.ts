import { describe, expect, it } from "vitest";

import {
  leadSubmissionAttribution,
  leadRequestPayload,
  privacySafeReferrer,
} from "@/lib/leads/client";

describe("lead request client payload", () => {
  it("trims fields, preserves explicit consent, and minimizes the referrer", () => {
    const data = new FormData();
    data.set("persona", "protocol_team");
    data.set("name", "  Partner Builder ");
    data.set("email", " partner@example.com ");
    data.set("project", "");
    data.set("workflow", "  Route a bounded workflow safely. ");
    data.set("trigger", " manual ");
    data.set("guardrails", " fixed recipient ");
    data.set("timeline", "within_30_days");
    data.set("consent", "on");

    expect(
      leadRequestPayload(
        data,
        {
          utmSource: "x",
          utmCampaign: "request_a_zap",
          entryPoint: "builder_review",
          landingPath: "/request-a-zap",
        },
        "https://www.0xzaps.com/zap?d=sensitive-design#step",
      ),
    ).toMatchObject({
      persona: "protocol_team",
      name: "Partner Builder",
      email: "partner@example.com",
      project: undefined,
      consent: true,
      website: "",
      attribution: {
        utmSource: "x",
        utmCampaign: "request_a_zap",
        entryPoint: "builder_review",
        landingPath: "/request-a-zap",
        referrer: "https://www.0xzaps.com",
      },
    });
  });

  it("does not let legacy or non-semantic autofill affect the API field", () => {
    const data = new FormData();
    data.set("persona", "agent_builder");
    data.set("name", "Partner Builder");
    data.set("email", "partner@example.com");
    data.set("workflow", "Route a bounded workflow safely.");
    data.set("trigger", "manual");
    data.set("guardrails", "fixed recipient");
    data.set("timeline", "within_30_days");
    data.set("consent", "on");
    data.set("website", "https://autofilled.example");
    data.set("requestNotes", "automated form filler");

    expect(
      leadRequestPayload(
        data,
        { landingPath: "/request-a-zap" },
        "https://www.0xzaps.com/request-a-zap",
      ),
    ).toMatchObject({ website: "" });
  });

  it("drops non-HTTPS and malformed referrers", () => {
    expect(privacySafeReferrer("http://example.com/path")).toBeUndefined();
    expect(privacySafeReferrer("not a url")).toBeUndefined();
  });

  it("carries controlled tab first-touch attribution across internal navigation", () => {
    expect(
      leadSubmissionAttribution(
        {
          utmSource: "openzaps",
          utmMedium: "website",
          utmCampaign: "request_a_zap",
          utmContent: "request_form",
          entryPoint: "builder_review",
          landingPath: "/request-a-zap",
        },
        {
          source: "x",
          medium: "social",
          campaign: "agent-kit-published-v2",
          content: "feed_update",
        },
      ),
    ).toEqual({
      utmSource: "x",
      utmMedium: "social",
      utmCampaign: "agent-kit-published-v2",
      utmContent: "feed_update",
      entryPoint: "builder_review",
      landingPath: "/request-a-zap",
    });
  });

  it("drops arbitrary query attribution before a lead payload is built", () => {
    expect(
      leadSubmissionAttribution(
        {
          utmSource: "personal-handle",
          utmMedium: "private-medium",
          utmCampaign: "openzaps-private-note",
          utmContent: "private-note",
          landingPath: "/request-a-zap",
        },
        null,
      ),
    ).toEqual({ landingPath: "/request-a-zap" });
  });
});
