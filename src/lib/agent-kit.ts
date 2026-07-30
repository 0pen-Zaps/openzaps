export const OPENZAPS_MCP_PACKAGE = "@openzaps/mcp";
export const OPENZAPS_MCP_VERSION = "0.1.0";
export const OPENZAPS_MCP_PACKAGE_SPEC =
  `${OPENZAPS_MCP_PACKAGE}@${OPENZAPS_MCP_VERSION}`;

/**
 * Both scoped 0.1.0 packages are published with npm provenance, but each
 * deployment must explicitly opt in before advertising the install surface.
 * Registry publication and deployment enablement are separate release gates.
 */
export function agentKitPublished(
  value: string | undefined,
): boolean {
  return value === "true";
}

// Keep this as a direct property access: Next.js only inlines NEXT_PUBLIC_* variables into client
// bundles when the reference is statically analyzable.
export const OPENZAPS_AGENT_KIT_PUBLISHED =
  process.env.NEXT_PUBLIC_OPENZAPS_AGENT_KIT_PUBLISHED === "true";

export const MCP_CLIENT_CONFIG = {
  mcpServers: {
    openzaps: {
      command: "npx",
      args: ["-y", OPENZAPS_MCP_PACKAGE_SPEC],
    },
  },
} as const;

/** Canonical paste-ready config. It never contains a checkout-specific path. */
export function mcpClientSnippet(): string {
  return JSON.stringify(MCP_CLIENT_CONFIG, null, 2);
}
