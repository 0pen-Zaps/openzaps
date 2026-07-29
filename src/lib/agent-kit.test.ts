import { describe, expect, it } from "vitest";

import { MCP_CLIENT_CONFIG, mcpClientSnippet } from "@/lib/agent-kit";

describe("Agent Kit install surface", () => {
  it("uses the npx package entrypoint rather than a cloned repository path", () => {
    expect(MCP_CLIENT_CONFIG.mcpServers.openzaps).toEqual({
      command: "npx",
      args: ["-y", "@openzaps/mcp"],
    });
    expect(mcpClientSnippet()).not.toMatch(/\/path\/to|\/Users\/|mcp\/index\.mjs/);
  });
});
