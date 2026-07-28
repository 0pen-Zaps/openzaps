import { describe, expect, it } from "vitest";

import {
  agentAlias,
  agentAliasStorageKey,
  connectedAgent,
  MAX_AGENT_ALIAS_LENGTH,
  MAX_AGENT_ALIASES,
  parseAgentAliases,
  resolveAgentConnection,
} from "@/lib/agent-connection";
import { OPEN_EXECUTOR } from "@/lib/automate";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OTHER_AGENT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const ZAP_A = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const ZAP_B = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07" as const;

describe("resolveAgentConnection", () => {
  it("reads the zero executor as open", () => {
    expect(resolveAgentConnection(OPEN_EXECUTOR, OWNER)).toEqual({ state: "open" });
  });

  it("separates owner-only from a pinned agent", () => {
    // These mean opposite things to a user: one is "I submit by hand", the
    // other is "an agent submits for me". Rendering both as "connected" lies.
    expect(resolveAgentConnection(OWNER, OWNER)).toEqual({ state: "self", agent: OWNER });
    expect(resolveAgentConnection(AGENT, OWNER)).toEqual({ state: "pinned", agent: AGENT });
  });

  it("compares addresses without regard to checksum case", () => {
    const lowered = OWNER.toLowerCase() as `0x${string}`;
    expect(resolveAgentConnection(lowered, OWNER)).toEqual({ state: "self", agent: OWNER });
    expect(resolveAgentConnection(AGENT.toLowerCase() as `0x${string}`, lowered)).toEqual({
      state: "pinned",
      agent: AGENT,
    });
  });

  it("always returns a checksummed agent address", () => {
    const connection = resolveAgentConnection(AGENT.toLowerCase() as `0x${string}`, OWNER);
    expect(connectedAgent(connection)).toBe(AGENT);
    expect(connectedAgent({ state: "open" })).toBeNull();
  });
});

describe("agent aliases", () => {
  it("scopes storage per owner, lowercased", () => {
    expect(agentAliasStorageKey(OWNER)).toBe(`openzap:v1:agent-aliases:${OWNER.toLowerCase()}`);
  });

  it("normalizes address keys and trims labels", () => {
    const aliases = parseAgentAliases(JSON.stringify({ [AGENT.toLowerCase()]: "  Claude on my MacBook  " }));
    expect(agentAlias(aliases, AGENT)).toBe("Claude on my MacBook");
  });

  it("drops malformed rows rather than repairing them", () => {
    const aliases = parseAgentAliases(
      JSON.stringify({
        "not-an-address": "nope",
        [AGENT]: 42,
        [OTHER_AGENT]: "  ",
        [ZAP_A]: "x".repeat(MAX_AGENT_ALIAS_LENGTH + 1),
        [ZAP_B]: "kept",
      }),
    );
    expect(Object.keys(aliases)).toEqual([ZAP_B.toLowerCase()]);
  });

  it("survives junk input", () => {
    expect(parseAgentAliases(null)).toEqual({});
    expect(parseAgentAliases("{")).toEqual({});
    expect(parseAgentAliases("[]")).toEqual({});
    expect(parseAgentAliases("null")).toEqual({});
  });

  it("caps how many aliases it will hold", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_AGENT_ALIASES + 10; i += 1) {
      many[`0x${(i + 1).toString(16).padStart(40, "0")}`] = `agent ${i}`;
    }
    expect(Object.keys(parseAgentAliases(JSON.stringify(many)))).toHaveLength(MAX_AGENT_ALIASES);
  });

  it("returns null for an agent with no label", () => {
    expect(agentAlias({}, AGENT)).toBeNull();
  });
});
