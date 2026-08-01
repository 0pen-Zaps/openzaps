import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RequestZapForm } from "./RequestZapForm";

const PROPS = {
  attribution: { landingPath: "/request-a-zap" as const },
  initialValues: {},
};

describe("RequestZapForm deployment boundary", () => {
  it("sends preview visitors to the canonical production form", () => {
    const markup = renderToStaticMarkup(
      createElement(RequestZapForm, {
        ...PROPS,
        isPreviewDeployment: true,
      }),
    );

    expect(markup).toContain("Preview deployment");
    expect(markup).toContain(
      'href="https://www.0xzaps.com/request-a-zap#request-form"',
    );
    expect(markup).not.toContain("Request my Zap review");
    expect(markup).not.toContain('name="email"');
  });

  it("keeps the real intake form enabled outside Vercel previews", () => {
    const markup = renderToStaticMarkup(createElement(RequestZapForm, PROPS));

    expect(markup).toContain("Request my Zap review");
    expect(markup).toContain('name="email"');
    expect(markup).not.toContain("Preview deployment");
  });
});
