import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import { describe, expect, it } from "vitest";

import {
  NON_PUBLIC_TUTORIAL_TITLES,
  PUBLIC_CONTENT_CATALOG_DIGEST,
  PUBLIC_CONTENT_ITEMS,
  publicContentCatalog,
  publicContentShareTargets,
} from "@/lib/marketing/public-content";

describe("public content catalog", () => {
  it("renders reviewed updates and only RSS-confirmed tutorials", () => {
    const titles = PUBLIC_CONTENT_ITEMS.map((item) => item.title);
    const tutorial = PUBLIC_CONTENT_ITEMS.find(
      (item) => item.kind === "tutorial",
    );

    expect(titles).toContain("Practice deployed routes in Virtual Trading");
    expect(titles).toContain("Inspect the first fixed 0xZAPS fee campaign");
    expect(titles).toContain("Connect an agent with the OpenZaps Agent Kit");
    expect(titles).toContain("Give an Agent the Trigger, Never the Authority");
    expect(titles).not.toContain("Paper Trade First, Then Draw the Authority Map");
    expect(NON_PUBLIC_TUTORIAL_TITLES).toContain(
      "Paper Trade First, Then Draw the Authority Map",
    );
    expect(PUBLIC_CONTENT_CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
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

  it("builds explicit tracked copy and X-composer links without publishing", () => {
    const product = PUBLIC_CONTENT_ITEMS.find(
      (item) => item.id === "openzaps:openzaps-virtual-trading-2026-07-30",
    );
    const tutorial = PUBLIC_CONTENT_ITEMS.find(
      (item) => item.kind === "tutorial",
    );
    expect(product).toBeDefined();
    expect(tutorial).toBeDefined();

    const productTargets = publicContentShareTargets(product!);
    const copyUrl = new URL(productTargets.copyUrl);
    const xIntent = new URL(productTargets.xIntentUrl);
    const xDestination = new URL(xIntent.searchParams.get("url")!);

    expect(copyUrl.origin).toBe("https://www.0xzaps.com");
    expect(copyUrl.pathname).toBe("/virtual-trading");
    expect(Object.fromEntries(copyUrl.searchParams)).toEqual({
      utm_source: "openzaps",
      utm_medium: "referral",
      utm_campaign: "product_update",
      utm_content: "learn_hub",
    });
    expect(xIntent.origin).toBe("https://x.com");
    expect(xIntent.pathname).toBe("/intent/post");
    expect(xIntent.searchParams.get("text")).toContain(
      "Practice deployed routes in Virtual Trading",
    );
    expect(xIntent.searchParams.get("text")).toContain("@0xzaps");
    expect(xDestination.origin).toBe("https://www.0xzaps.com");
    expect(xDestination.searchParams.get("utm_source")).toBe("x");
    expect(xDestination.searchParams.get("utm_medium")).toBe("social");

    const tutorialDestination = new URL(
      new URL(publicContentShareTargets(tutorial!).xIntentUrl).searchParams.get("url")!,
    );
    expect(tutorialDestination.hostname).toBe("defitutorials.substack.com");
    expect(tutorialDestination.searchParams.get("utm_campaign")).toBe(
      "tutorial_update",
    );
  });
});
