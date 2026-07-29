export const OPENZAPS_MCP_PACKAGE = "@openzaps/mcp";

/**
 * The install snippet must not be advertised before the scoped npm package
 * exists. Source readiness and registry publication are separate release facts.
 */
export const OPENZAPS_AGENT_KIT_PUBLISHED =
  process.env.NEXT_PUBLIC_OPENZAPS_AGENT_KIT_PUBLISHED === "true";

export const MCP_CLIENT_CONFIG = {
  mcpServers: {
    openzaps: {
      command: "npx",
      args: ["-y", OPENZAPS_MCP_PACKAGE],
    },
  },
} as const;

/** Canonical paste-ready config. It never contains a checkout-specific path. */
export function mcpClientSnippet(): string {
  return JSON.stringify(MCP_CLIENT_CONFIG, null, 2);
}
