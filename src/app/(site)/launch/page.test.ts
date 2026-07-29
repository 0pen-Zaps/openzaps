import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ZapPadReleaseStatus } from "./page";

describe("ZapPad release status", () => {
  it("renders the source-ready, not-deployed boundary required by the release runbook", () => {
    const html = renderToStaticMarkup(createElement(ZapPadReleaseStatus));

    expect(html).toContain("Source-ready, not deployed.");
    expect(html).toContain("No ZapPad launcher address is approved");
    expect(html).toContain("Reads and launches stay disabled");
  });
});
