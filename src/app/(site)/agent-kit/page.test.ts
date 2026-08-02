import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-kit")>()),
  OPENZAPS_AGENT_KIT_PUBLISHED: true,
}));

import AgentKitPage from "@/app/(site)/agent-kit/page";

describe("Agent Kit page", () => {
  it("renders the exact published packages and keeps execution authority separate", () => {
    const html = renderToStaticMarkup(createElement(AgentKitPage));

    expect(html).toContain("@openzaps/sdk@0.1.0");
    expect(html).toContain("@openzaps/mcp@0.1.0");
    expect(html).toContain("npm install @openzaps/sdk@0.1.0");
    expect(html).toContain("&quot;command&quot;: &quot;npx&quot;");
    expect(html).toContain("Neither package signs or broadcasts");
    expect(html).toContain("separate executor");
    expect(html).toContain("One-shot Zaps cannot be connected");
    expect(html).toContain("deployment-gated");
    expect(html).toContain("Pre-audit software");
    expect(html).toContain("utm_campaign=openzaps-agent-kit");
    expect(html).toContain("utm_content=agent_kit");
    expect(html).toContain('aria-label="Copy SDK install command"');
    expect(html).toContain('aria-label="Copy MCP client configuration"');
    expect(html).toContain('"softwareRequirements":"Node.js 20 or newer"');
    expect(html).toContain('data-agent-kit-boundary="read-only-and-unsigned"');
    expect(html).toContain("https://www.0xzaps.com/agent-kit#webpage");
  });
});
