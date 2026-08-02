import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import LegalPage from "@/app/(site)/legal/page";

describe("Legal page", () => {
  it("publishes the Discord app terms and privacy boundary", () => {
    const html = renderToStaticMarkup(createElement(LegalPage));

    expect(html).toContain('id="discord-app-terms"');
    expect(html).toContain('id="discord-app-privacy"');
    expect(html).toContain("Effective August 1, 2026");
    expect(html).toContain("/ask, /openzaps, and /status");
    expect(html).toContain("does not connect a wallet, request a signature");
    expect(html).toContain("does not read ordinary server messages");
    expect(html).toContain("does not persist the command question");
    expect(html).toContain("does not intentionally write interaction payloads");
    expect(html).toContain("normally has no application-level Discord record to delete");
    expect(html).toContain("Discord processes the interaction under its own terms");
    expect(html).toContain("github.com/0pen-Zaps/openzaps/security/advisories/new");
  });
});
