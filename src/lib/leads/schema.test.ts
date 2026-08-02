import { describe, expect, it } from "vitest";

import { qualificationScore } from "@/lib/leads/qualification";
import { LeadRequestSchema } from "@/lib/leads/schema";

const validLead = {
  persona: "agent_builder",
  name: "Nodar Janashia",
  email: "Nodar@Example.com",
  project: "OpenZaps",
  projectUrl: "https://www.0xzaps.com",
  workflow:
    "When a bounded trigger fires, route capital through a pre-approved OpenZap without expanding wallet authority.",
  protocolsAssets: "Uniswap v4, USDC, WETH",
  trigger: "A reviewed price and liquidity threshold is reached.",
  guardrails:
    "Cap spend at 1,000 USDC, allow only WETH, and stop after one execution.",
  timeline: "within_30_days",
  consent: true,
  website: "",
  attribution: {
    utmSource: "x",
    landingPath: "/request-a-zap",
    referrer: "https://x.com/0xzaps",
  },
} as const;

describe("LeadRequestSchema", () => {
  it("normalizes bounded lead data without widening the object", () => {
    const parsed = LeadRequestSchema.parse({
      ...validLead,
      name: "  Nodar Janashia  ",
      email: "  Nodar@Example.com ",
      project: "   ",
    });

    expect(parsed).toMatchObject({
      name: "Nodar Janashia",
      email: "nodar@example.com",
      project: undefined,
      consent: true,
      website: "",
    });
  });

  it("rejects unknown top-level and attribution fields", () => {
    expect(
      LeadRequestSchema.safeParse({
        ...validLead,
        marketingOptIn: true,
      }).success,
    ).toBe(false);
    expect(
      LeadRequestSchema.safeParse({
        ...validLead,
        attribution: {
          ...validLead.attribution,
          arbitraryTracking: "no",
        },
      }).success,
    ).toBe(false);
  });

  it("requires HTTPS URLs without embedded credentials", () => {
    for (const projectUrl of [
      "http://example.com",
      "https://user:password@example.com",
      "not a url",
    ]) {
      expect(
        LeadRequestSchema.safeParse({ ...validLead, projectUrl }).success,
      ).toBe(false);
    }
  });

  it("keeps only the referrer origin before persistence", () => {
    const parsed = LeadRequestSchema.parse({
      ...validLead,
      attribution: {
        ...validLead.attribution,
        referrer: "https://example.com/tutorial?email=person@example.com#step-2",
      },
    });

    expect(parsed.attribution.referrer).toBe("https://example.com");
  });

  it("accepts only the explicit builder-review entry point", () => {
    expect(
      LeadRequestSchema.parse({
        ...validLead,
        attribution: {
          ...validLead.attribution,
          entryPoint: "builder_review",
        },
      }).attribution.entryPoint,
    ).toBe("builder_review");
    expect(
      LeadRequestSchema.safeParse({
        ...validLead,
        attribution: {
          ...validLead.attribution,
          entryPoint: "private_route",
        },
      }).success,
    ).toBe(false);
  });

  it("drops sensitive or malformed campaign attribution", () => {
    const parsed = LeadRequestSchema.parse({
      ...validLead,
      attribution: {
        utmSource: "x",
        utmMedium: "social",
        utmCampaign: "person@example.com",
        utmContent: `0x${"a".repeat(40)}`,
        utmTerm: "request a zap",
      },
    });

    expect(parsed.attribution).toEqual({
      utmSource: "x",
      utmMedium: "social",
      utmCampaign: undefined,
      utmContent: undefined,
      utmTerm: "request a zap",
    });
  });

  it("requires explicit contact consent and bounded substantive fields", () => {
    expect(
      LeadRequestSchema.safeParse({ ...validLead, consent: false }).success,
    ).toBe(false);
    expect(
      LeadRequestSchema.safeParse({ ...validLead, workflow: "too short" })
        .success,
    ).toBe(false);
    expect(
      LeadRequestSchema.safeParse({
        ...validLead,
        guardrails: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe("qualificationScore", () => {
  it("returns five only when every published qualification signal is present", () => {
    const lead = LeadRequestSchema.parse(validLead);
    expect(qualificationScore(lead)).toBe(5);
  });

  it("returns zero for an exploratory request without concrete enrichment", () => {
    const lead = LeadRequestSchema.parse({
      ...validLead,
      project: "",
      projectUrl: "",
      workflow: "Explore whether a short bounded automation could be useful.",
      protocolsAssets: "",
      guardrails: "Keep it safe.",
      timeline: "exploring",
    });
    expect(qualificationScore(lead)).toBe(0);
  });
});
