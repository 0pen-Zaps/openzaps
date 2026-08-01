import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import LearnPage from "@/app/(site)/learn/page";
import {
  PUBLIC_CONTENT_CATALOG_DIGEST,
  PUBLIC_CONTENT_ITEMS,
} from "@/lib/marketing/public-content";

describe("Learn page", () => {
  it("renders only verified public content and a measurable request path", () => {
    const html = renderToStaticMarkup(createElement(LearnPage));

    expect(html).toContain("Practice deployed routes in Virtual Trading");
    expect(html).toContain("Give an Agent the Trigger, Never the Authority");
    expect(html).not.toContain("Paper Trade First, Then Draw the Authority Map");
    expect(html).toContain(
      "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the",
    );
    expect(html).toContain("utm_source=openzaps");
    expect(html).toContain("utm_content=learn_hub");
    expect(html).toContain("Pre-audit software");
    expect(html).toContain(
      "Drafts and editor handoffs are withheld from this catalog until",
    );
    expect(html).toContain(
      'data-publication-boundary="reviewed-feed-and-rss-confirmed"',
    );
    expect(html).toContain(
      `data-public-content-digest="${PUBLIC_CONTENT_CATALOG_DIGEST}"`,
    );
    expect(html.match(/data-public-content-id=/gu)).toHaveLength(
      PUBLIC_CONTENT_ITEMS.length,
    );
  });
});
