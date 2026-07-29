import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/JsonLd", () => ({ JsonLd: () => null }));
vi.mock("@/components/zappad/launch-studio", () => ({
  LaunchStudio: () => null,
}));
vi.mock("@/components/zappad/page-hero", () => ({ PageHero: () => null }));
vi.mock("@/components/zappad/protocol-snapshot", () => ({
  ProtocolSnapshot: () => null,
}));

import ZapPadStudioPage from "./page";

describe("ZapPad release status", () => {
  it("keeps the source-ready, not-deployed boundary on the rendered route", () => {
    const html = renderToStaticMarkup(createElement(ZapPadStudioPage));

    expect(html).toContain('data-zappad-release-status="source-ready"');
    expect(html).toContain("Source-ready, not deployed.");
    expect(html).toContain("No ZapPad launcher address is approved");
    expect(html).toContain("Reads and launches stay disabled");
  });
});
