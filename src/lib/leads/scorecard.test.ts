import { describe, expect, it } from "vitest";

import type { OperatorLead } from "@/lib/leads/server";
import {
  buildLeadScorecard,
  leadReviewDueAt,
  leadReviewSla,
  sortLeadsForReview,
} from "@/lib/leads/scorecard";

function lead(
  overrides: Partial<OperatorLead> = {},
): OperatorLead {
  return {
    id: crypto.randomUUID(),
    persona: "protocol_team",
    name: "Protocol team",
    email: "team@example.com",
    project: "Protocol",
    projectUrl: "https://example.com",
    workflow: "Run one tightly bounded workflow after a verified trigger.",
    protocolsAssets: "USDC",
    trigger: "A verified event",
    guardrails: "A fixed recipient and spend cap",
    timeline: "within_30_days",
    consentToContact: true,
    consentVersion: "lead-contact-v1",
    consentedAt: "2026-07-31T15:00:00.000Z",
    emailVerified: false,
    attribution: {},
    qualificationScore: 4,
    status: "new",
    createdAt: "2026-07-31T15:00:00.000Z",
    updatedAt: "2026-07-31T15:00:00.000Z",
    expiresAt: "2027-01-27T15:00:00.000Z",
    ...overrides,
  };
}

describe("lead review SLA", () => {
  it("counts the next two weekdays in Eastern time and uses end of due day", () => {
    expect(leadReviewDueAt("2026-07-31T15:00:00.000Z")).toBe(
      "2026-08-05T03:59:59.999Z",
    );
    expect(leadReviewDueAt("2026-08-01T15:00:00.000Z")).toBe(
      "2026-08-05T03:59:59.999Z",
    );
    expect(leadReviewDueAt("2026-11-01T16:00:00.000Z")).toBe(
      "2026-11-04T04:59:59.999Z",
    );
  });

  it("applies only to score-three-plus requests that are still new", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    expect(leadReviewSla(lead(), now)?.state).toBe("overdue");
    expect(leadReviewSla(lead({ qualificationScore: 2 }), now)).toBeNull();
    expect(leadReviewSla(lead({ status: "contacted" }), now)).toBeNull();
    expect(leadReviewDueAt("not-a-date")).toBeNull();
  });

  it("orders overdue work before due work and the rest of the queue", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const overdue = lead({
      id: "019fab5e-be72-72d2-809b-0a1d4a35c861",
      createdAt: "2026-07-31T15:00:00.000Z",
    });
    const due = lead({
      id: "019fab5e-be72-72d2-809b-0a1d4a35c862",
      createdAt: "2026-08-05T15:00:00.000Z",
    });
    const progressed = lead({
      id: "019fab5e-be72-72d2-809b-0a1d4a35c863",
      qualificationScore: 5,
      status: "qualified",
    });

    expect(sortLeadsForReview([progressed, due, overdue], now).map((item) => item.id))
      .toEqual([overdue.id, due.id, progressed.id]);
  });
});

describe("lead growth scorecard", () => {
  it("reports rolling conversions, backlog SLA, and coarse attribution", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const scorecard = buildLeadScorecard([
      lead({
        createdAt: "2026-08-05T15:00:00.000Z",
        attribution: {
          utmSource: "X",
          utmCampaign: "agent_kit",
          utmContent: "feed_update",
        },
      }),
      lead({
        createdAt: "2026-07-31T15:00:00.000Z",
        status: "qualified",
        qualificationScore: 5,
        attribution: {
          referrer: "https://discord.com",
          utmCampaign: "agent_kit",
        },
      }),
      lead({
        createdAt: "2026-07-01T15:00:00.000Z",
        qualificationScore: 2,
      }),
    ], now);

    expect(scorecard).toMatchObject({
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      scope: {
        basis: "accepted_requests_onward",
        returnedRows: 3,
        truncated: false,
        complete: true,
      },
      windows: {
        days7: {
          accepted: 2,
          score3Plus: 2,
          progressed: 1,
          currentQualified: 1,
        },
        days30: {
          accepted: 2,
          score3Plus: 2,
          progressed: 1,
          currentQualified: 1,
        },
      },
      overdueReviewCount: 0,
      stages: { new: 2, contacted: 0, qualified: 1, closed: 0 },
    });
    expect(scorecard.attribution).toEqual([
      {
        source: "discord",
        campaign: "agent_kit",
        content: "not_set",
        accepted: 1,
        score3Plus: 1,
        currentQualified: 1,
      },
      {
        source: "x",
        campaign: "agent_kit",
        content: "feed_update",
        accepted: 1,
        score3Plus: 1,
        currentQualified: 0,
      },
    ]);
  });

  it("labels the top-100 fallback as truncated and buckets every unrecognized dimension", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const leads = Array.from({ length: 101 }, (_, index) => lead({
      id: `019fab5e-be72-72d2-809b-${String(index).padStart(12, "0")}`,
      attribution: index === 0
        ? {
            utmSource: "Nodar Janashia",
            utmCampaign: "12125551212",
            utmContent: "192.0.2.1",
          }
        : {},
    }));

    const scorecard = buildLeadScorecard(leads, now);
    const serialized = JSON.stringify(scorecard);

    expect(scorecard.scope).toMatchObject({
      maxRows: 100,
      returnedRows: 100,
      truncated: true,
      complete: false,
    });
    expect(serialized).not.toContain("nodar");
    expect(serialized).not.toContain("12125551212");
    expect(serialized).not.toContain("192.0.2.1");
    expect(scorecard.attribution).toContainEqual({
      source: "other",
      campaign: "other",
      content: "other",
      accepted: 1,
      score3Plus: 1,
      currentQualified: 0,
    });
  });

  it("conservatively marks an exact 100-row result as truncated", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const scorecard = buildLeadScorecard(
      Array.from({ length: 100 }, (_, index) => lead({
        id: `019fab5e-be72-72d2-809b-${String(index).padStart(12, "0")}`,
      })),
      now,
    );

    expect(scorecard.scope).toMatchObject({
      returnedRows: 100,
      truncated: true,
      complete: false,
    });
  });

  it("preserves attribution totals in a finite remaining bucket", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const sources = [
      "discord",
      "farcaster",
      "github",
      "homepage",
      "newsletter",
      "openzaps",
      "rss",
      "substack",
      "x",
    ];
    const leads = Array.from({ length: 15 }, (_, index) => lead({
      attribution: {
        utmSource: sources[index % sources.length],
        utmCampaign: index < sources.length ? "agent_kit" : "learn_hub",
        utmContent: index % 2 === 0 ? "feed_update" : "hero",
      },
      createdAt: "2026-08-05T15:00:00.000Z",
    }));

    const scorecard = buildLeadScorecard(leads, now);
    const totals = scorecard.attribution.reduce(
      (sum, row) => sum + row.accepted,
      0,
    );

    expect(scorecard.attribution).toHaveLength(12);
    expect(scorecard.attribution.at(-1)).toMatchObject({
      source: "remaining",
      campaign: "remaining",
      content: "remaining",
    });
    expect(totals).toBe(15);
  });
});
