import { describe, expect, it } from "vitest";

import {
  agentKitPublished,
  MCP_CLIENT_CONFIG,
  mcpClientSnippet,
} from "@/lib/agent-kit";

describe("Agent Kit install surface", () => {
  it("uses the npx package entrypoint rather than a cloned repository path", () => {
    expect(MCP_CLIENT_CONFIG.mcpServers.openzaps).toEqual({
      command: "npx",
      args: ["-y", "@openzaps/mcp@0.1.0"],
    });
    expect(mcpClientSnippet()).not.toMatch(/\/path\/to|\/Users\/|mcp\/index\.mjs/);
  });

  it("requires explicit deployment enablement even after registry publication", () => {
    expect(agentKitPublished(undefined)).toBe(false);
    expect(agentKitPublished("true")).toBe(true);
    expect(agentKitPublished("false")).toBe(false);
  });
});
