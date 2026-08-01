import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import LearnPage from "@/app/(site)/learn/page";

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
    expect(html).toContain("Drafts and editor handoffs stay private");
  });
});
