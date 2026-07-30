import { describe, expect, it } from "vitest";

import {
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
    data.set("website", "");

    expect(
      leadRequestPayload(
        data,
        {
          utmSource: "x",
          utmCampaign: "request_a_zap",
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
        landingPath: "/request-a-zap",
        referrer: "https://www.0xzaps.com",
      },
    });
  });

  it("drops non-HTTPS and malformed referrers", () => {
    expect(privacySafeReferrer("http://example.com/path")).toBeUndefined();
    expect(privacySafeReferrer("not a url")).toBeUndefined();
  });
});
