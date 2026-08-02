import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  SITE_NAME,
  SITE_URL,
  STATIC_PAGE_SEO,
  absoluteUrl,
  brandedTitle,
  breadcrumbJsonLd,
  jsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

describe("SEO primitives", () => {
  it("keeps canonical URLs on the configured production origin", () => {
    expect(SITE_URL).toMatch(/^https:\/\//);
    expect(absoluteUrl("/")).toBe(SITE_URL);
    expect(absoluteUrl("docs")).toBe(`${SITE_URL}/docs`);
    expect(absoluteUrl("https://example.com/page")).toBe("https://example.com/page");
  });

  it("defines unique, search-sized metadata for every indexable static page", () => {
    const entries = Object.values(STATIC_PAGE_SEO);
    const paths = entries.map(({ path }) => path);

    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of entries) {
      const renderedTitle = brandedTitle(entry.title);
      expect(entry.path).toMatch(/^\//);
      expect(renderedTitle.length, `${entry.path} title length`).toBeGreaterThanOrEqual(30);
      expect(renderedTitle.length, `${entry.path} title length`).toBeLessThanOrEqual(60);
      expect(entry.description.length, `${entry.path} description length`).toBeGreaterThanOrEqual(120);
      expect(entry.description.length, `${entry.path} description length`).toBeLessThanOrEqual(160);
      expect(entry.ogImage).toMatch(/^\/.*\.png$/);
      expect(entry.priority).toBeGreaterThan(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
    }
  });

  it("indexes virtual trading without reviving retired game URLs", () => {
    const entries = Object.values(STATIC_PAGE_SEO);
    const paths = entries.map(({ path }) => path);

    expect(STATIC_PAGE_SEO.virtualTrading.path).toBe("/virtual-trading");
    expect(paths).not.toContain("/zapdraw");
    expect(paths).not.toContain("/zapdraw/how");
    expect(Object.keys(STATIC_PAGE_SEO)).not.toContain("zapdraw");
    expect(Object.keys(STATIC_PAGE_SEO)).not.toContain("zapdrawHow");
  });

  it("indexes the verified learning hub", () => {
    expect(STATIC_PAGE_SEO.learn).toMatchObject({
      path: "/learn",
      changeFrequency: "weekly",
      priority: 0.75,
    });
  });

  it("indexes the bounded Agent Kit surface", () => {
    expect(STATIC_PAGE_SEO.agentKit).toMatchObject({
      path: "/agent-kit",
      changeFrequency: "weekly",
      priority: 0.85,
    });
  });

  it("emits canonical, Open Graph, and Twitter metadata from one route definition", () => {
    const entry = STATIC_PAGE_SEO.docs;
    const metadata = pageMetadata(entry);
    const openGraph = metadata.openGraph as { images?: Array<{ alt?: string }>; url?: string };
    const twitter = metadata.twitter as { images?: Array<{ alt?: string }>; title?: string };

    expect(metadata.title).toBe(entry.title);
    expect(metadata.description).toBe(entry.description);
    expect(metadata.alternates?.canonical).toBe(`${SITE_URL}${entry.path}`);
    expect(openGraph.url).toBe(`${SITE_URL}${entry.path}`);
    expect(openGraph.images?.[0]?.alt).toContain(SITE_NAME);
    expect(twitter.title).toContain(SITE_NAME);
    expect(twitter.images?.[0]?.alt).toContain(SITE_NAME);
  });

  it("links WebPage and breadcrumb entities to stable canonical ids", () => {
    const page = webPageJsonLd(STATIC_PAGE_SEO.home) as {
      "@id": string;
      isPartOf: { "@id": string };
    };
    const breadcrumbs = breadcrumbJsonLd("/docs", "Developer docs") as {
      itemListElement: Array<Record<string, unknown>>;
    };

    expect(page["@id"]).toBe(`${SITE_URL}/#webpage`);
    expect(page.isPartOf).toEqual({ "@id": `${SITE_URL}/#website` });
    expect(breadcrumbs.itemListElement[1]).toMatchObject({
      position: 2,
      item: `${SITE_URL}/docs`,
    });
  });

  it("escapes HTML-significant and JavaScript line-separator characters in JSON-LD", () => {
    const serialized = jsonLd({ value: "<script>&\u2028\u2029" });

    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("&");
    expect(serialized).not.toContain("\u2028");
    expect(serialized).not.toContain("\u2029");
    expect(serialized).toContain("\\u003cscript\\u003e");
  });

  it("keeps the default homepage metadata aligned with the homepage SEO entry", () => {
    expect(DEFAULT_TITLE).toBe(brandedTitle(STATIC_PAGE_SEO.home.title));
    expect(DEFAULT_DESCRIPTION).toBe(STATIC_PAGE_SEO.home.description);
  });
});
