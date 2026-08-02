import { describe, expect, it } from "vitest";

import {
  LEAD_HONEYPOT_FIELD_NAME,
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
    data.set(LEAD_HONEYPOT_FIELD_NAME, "");

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

  it("does not let semantic website autofill trip the browser honeypot", () => {
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
    data.set(LEAD_HONEYPOT_FIELD_NAME, "");

    expect(
      leadRequestPayload(
        data,
        { landingPath: "/request-a-zap" },
        "https://www.0xzaps.com/request-a-zap",
      ),
    ).toMatchObject({ website: "" });
  });

  it("still maps the non-semantic browser trap to the API honeypot field", () => {
    const data = new FormData();
    data.set(LEAD_HONEYPOT_FIELD_NAME, "automated form filler");

    expect(
      leadRequestPayload(
        data,
        { landingPath: "/request-a-zap" },
        "",
      ),
    ).toMatchObject({ website: "automated form filler" });
  });

  it("drops non-HTTPS and malformed referrers", () => {
    expect(privacySafeReferrer("http://example.com/path")).toBeUndefined();
    expect(privacySafeReferrer("not a url")).toBeUndefined();
  });
});
