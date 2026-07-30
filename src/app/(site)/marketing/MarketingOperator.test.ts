import { describe, expect, it } from "vitest";

import { operatorLeads } from "./MarketingOperator";

const VALID_LEAD = {
  id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
  persona: "protocol_team",
  name: "Partner Builder",
  email: "partner@example.com",
  emailVerified: false,
  project: "Partner Protocol",
  projectUrl: "https://example.com",
  workflow: "Route a bounded protocol workflow with fixed authority.",
  protocolsAssets: "USDC, WETH",
  trigger: "A reviewed manual trigger",
  guardrails: "Fixed recipient, target, spend limit, and expiry",
  timeline: "within_30_days",
  attribution: { utmSource: "x" },
  qualificationScore: 5,
  status: "new",
  createdAt: "2026-07-30T02:00:00.000Z",
  updatedAt: "2026-07-30T02:00:00.000Z",
  expiresAt: "2027-01-26T02:00:00.000Z",
};

describe("operator lead queue parsing", () => {
  it("keeps a bounded operator lead and its verification state", () => {
    expect(operatorLeads({ leads: [VALID_LEAD] })).toEqual([VALID_LEAD]);
  });

  it("drops malformed entries and refuses oversized queues", () => {
    expect(
      operatorLeads({
        leads: [
          { ...VALID_LEAD, qualificationScore: 6 },
          { ...VALID_LEAD, emailVerified: "yes" },
          { ...VALID_LEAD, status: "emailed" },
        ],
      }),
    ).toEqual([]);

    expect(
      operatorLeads({ leads: Array.from({ length: 101 }, () => VALID_LEAD) }),
    ).toEqual([]);
  });
});
