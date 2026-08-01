import { describe, expect, it } from "vitest";

import {
  TutorialPublicationError,
  normalizeConfirmedTutorialManifest,
  normalizeWithheldTutorialTitles,
} from "@/lib/marketing/tutorial-publication";

function manifest(tutorials: unknown[]): unknown {
  return {
    version: 1,
    publication: "https://defitutorials.substack.com",
    feed: "https://defitutorials.substack.com/feed",
    tutorials,
  };
}

const CONFIRMED = {
  id: "bounded-agent-authority",
  title: "  Bounded Agent   Authority  ",
  status: "rss_confirmed",
  canonicalUrl: "https://defitutorials.substack.com/p/bounded-agent-authority",
  publishedAt: "2026-07-29T16:55:32Z",
};

describe("confirmed tutorial publication boundary", () => {
  it("returns only canonical RSS-confirmed tutorials", () => {
    expect(
      normalizeConfirmedTutorialManifest(
        manifest([
          {
            id: "private-draft",
            title: "Private draft",
            status: "draft",
            canonicalUrl: null,
            publishedAt: null,
          },
          {
            id: "prepared-handoff",
            title: "Prepared handoff",
            status: "approved_handoff",
            canonicalUrl: null,
            publishedAt: null,
          },
          CONFIRMED,
        ]),
      ),
    ).toEqual([
      {
        id: "bounded-agent-authority",
        title: "Bounded Agent Authority",
        canonicalUrl:
          "https://defitutorials.substack.com/p/bounded-agent-authority",
        publishedAt: "2026-07-29T16:55:32.000Z",
      },
    ]);
  });

  it("fails closed on a noncanonical or duplicate public receipt", () => {
    expect(() =>
      normalizeConfirmedTutorialManifest(
        manifest([
          CONFIRMED,
          { ...CONFIRMED, id: "duplicate-url" },
        ]),
      ),
    ).toThrow(TutorialPublicationError);

    expect(() =>
      normalizeConfirmedTutorialManifest(
        manifest([
          {
            ...CONFIRMED,
            canonicalUrl:
              "https://defitutorials.substack.com/p/bounded-agent-authority?draft=1",
          },
        ]),
      ),
    ).toThrow("not canonical");
  });

  it("normalizes the titles that must remain absent before RSS confirmation", () => {
    expect(
      normalizeWithheldTutorialTitles(
        manifest([
          CONFIRMED,
          { title: "  Private   draft ", status: "draft" },
          { title: "Prepared handoff", status: "approved_handoff" },
        ]),
      ),
    ).toEqual(["Prepared handoff", "Private draft"]);

    expect(() =>
      normalizeWithheldTutorialTitles(
        manifest([
          { title: "Duplicate", status: "draft" },
          { title: "Duplicate", status: "approved_handoff" },
        ]),
      ),
    ).toThrow(TutorialPublicationError);
  });
});
