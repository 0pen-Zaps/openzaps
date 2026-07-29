import { describe, expect, it } from "vitest";

import { AGENT_CONNECTIONS_PROVENANCE } from "@/app/api/agents/[address]/route";
import { agentConnectionsPageLimit } from "@/lib/agent-connections-server";

describe("agent connections pagination", () => {
  it("uses a bounded default and rejects full-history page sizes", () => {
    expect(agentConnectionsPageLimit(null)).toBe(25);
    expect(agentConnectionsPageLimit("50")).toBe(50);
    expect(() => agentConnectionsPageLimit("51")).toThrow("1 to 50");
    expect(() => agentConnectionsPageLimit("500")).toThrow("1 to 50");
  });

  it("labels relay discovery as non-authoritative and potentially stale", () => {
    expect(AGENT_CONNECTIONS_PROVENANCE).toEqual({
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: expect.stringMatching(/verify the capsule at a pinned canonical block/i),
    });
  });
});
