import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import { describe, expect, it } from "vitest";

import {
  PUBLIC_CONTENT_ITEMS,
  publicContentCatalog,
} from "@/lib/marketing/public-content";

describe("public content catalog", () => {
  it("renders reviewed updates and only RSS-confirmed tutorials", () => {
    const titles = PUBLIC_CONTENT_ITEMS.map((item) => item.title);
    const tutorial = PUBLIC_CONTENT_ITEMS.find(
      (item) => item.kind === "tutorial",
    );

    expect(titles).toContain("Practice deployed routes in Virtual Trading");
    expect(titles).toContain("Give an Agent the Trigger, Never the Authority");
    expect(titles).not.toContain("Paper Trade First, Then Draw the Authority Map");
    expect(tutorial).toMatchObject({
      sourceLabel: "DeFi Tutorials",
      canonicalUrl:
        "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the",
      external: true,
    });
    expect(PUBLIC_CONTENT_ITEMS.map((item) => item.publishedAt)).toEqual(
      [...PUBLIC_CONTENT_ITEMS]
        .sort(
          (left, right) =>
            Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
            || left.id.localeCompare(right.id),
        )
        .map((item) => item.publishedAt),
    );
  });

  it("fails closed when an owned update conflicts with another canonical URL", () => {
    const feed = [
      {
        id: "first",
        title: "First",
        description: "First reviewed update.",
        url: "https://www.0xzaps.com/docs",
        publishedAt: "2026-07-29T00:00:00.000Z",
      },
      {
        id: "second",
        title: "Second",
        description: "Second reviewed update.",
        url: "https://www.0xzaps.com/docs",
        publishedAt: "2026-07-30T00:00:00.000Z",
      },
    ];

    expect(() => publicContentCatalog(tutorialManifestJson, feed)).toThrow(
      "must be unique",
    );
  });
});
