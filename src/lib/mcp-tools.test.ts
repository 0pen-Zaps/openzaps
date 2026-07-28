import { describe, expect, it } from "vitest";

/**
 * Guards on the MCP server's tool table.
 *
 * The server itself is plain ESM under `mcp/`, outside vitest's `src/**` include — but the
 * invariants worth protecting are about the SHAPE of the table, not about the chain, so they run
 * fine here by importing it. The one that matters is the last test: nothing in that server may ever
 * be able to broadcast, and "we remembered not to" is not a guarantee.
 */
const mcp = await import("../../mcp/tools.mjs");

const { TOOLS, READ_ONLY, PUBLISH, assertNoBroadcastTools, namedError, ERRORS } = mcp as {
  TOOLS: Array<{ name: string; safety: string; description: string; inputSchema: Record<string, unknown>; handler: unknown }>;
  READ_ONLY: string;
  PUBLISH: string;
  assertNoBroadcastTools: (tools?: unknown[]) => void;
  namedError: (message: unknown) => string | null;
  ERRORS: Record<string, string>;
};

describe("MCP tool table", () => {
  it("declares every tool with a name, safety class, description and schema", () => {
    for (const tool of TOOLS) {
      expect(typeof tool.name, tool.name).toBe("string");
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(typeof tool.description, tool.name).toBe("string");
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(typeof tool.handler, tool.name).toBe("function");
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
    }
  });

  it("has unique tool names", () => {
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
  });

  it("closes every input schema against extra properties", () => {
    // An open schema lets a model smuggle a field the handler never validates.
    for (const tool of TOOLS) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("bounds every address and uint input with a pattern", () => {
    for (const tool of TOOLS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, schema] of Object.entries(properties)) {
        if (schema.type !== "string") continue;
        const bounded = "pattern" in schema || "enum" in schema || "maxLength" in schema;
        expect(bounded, `${tool.name}.${key} must be bounded`).toBe(true);
      }
    }
  });

  it("exposes NO tool that can broadcast a transaction", () => {
    // The classes are the design: read-only changes nothing, publish moves an
    // artifact the owner already signed. There is deliberately no third class,
    // and adding a tool without one must fail loudly rather than ship quietly.
    expect(() => assertNoBroadcastTools()).not.toThrow();
    for (const tool of TOOLS) {
      expect([READ_ONLY, PUBLISH], tool.name).toContain(tool.safety);
    }
    expect(() => assertNoBroadcastTools([{ name: "rogue", safety: "broadcast" }])).toThrow(/rogue/);
  });

  it("names no tool that suggests it signs, funds, or drains", () => {
    const forbidden = /sign|broadcast|send_tx|fund|drain|withdraw|private_key|seed/i;
    for (const tool of TOOLS) {
      expect(forbidden.test(tool.name), tool.name).toBe(false);
    }
  });
});

describe("the publish class", () => {
  const publishTools = TOOLS.filter((tool) => tool.safety === PUBLISH);

  it("exists and is small", () => {
    expect(publishTools.map((tool) => tool.name)).toEqual(["publish_intent", "deliver_intent_local"]);
  });

  it("only ever moves an artifact that is already signed", () => {
    // The class boundary in one assertion: a publish tool takes a signed
    // artifact and nothing else. It has no way to express "create authority".
    for (const tool of publishTools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      expect(Object.keys(properties), tool.name).toEqual(["signedIntent"]);

      const signed = properties.signedIntent as { required?: string[]; properties?: Record<string, { pattern?: string }> };
      expect(signed.required, tool.name).toContain("signature");
      // A signature shaped like anything shorter than 65 bytes is rejected before
      // the tool touches the network.
      expect(signed.properties?.signature.pattern, tool.name).toContain("130,");
    }
  });

  it("has no tool that submits a run", () => {
    // An agent that submits runs does so by BEING the executor daemon with its
    // own gas key — a process the user starts deliberately — not by this server
    // holding one.
    for (const forbidden of ["submit_run", "execute", "create_zap", "fund_zap", "revoke", "invalidate_nonce"]) {
      expect(TOOLS.map((tool) => tool.name), forbidden).not.toContain(forbidden);
    }
  });

  it("keeps draft_intent read-only — a draft is not an authorization", () => {
    const draft = TOOLS.find((tool) => tool.name === "draft_intent");
    expect(draft?.safety).toBe(READ_ONLY);
    expect(draft?.description).toContain("UNSIGNED");
  });
});

describe("explain_error", () => {
  it("recognizes the capsule errors an agent will actually hit", () => {
    for (const name of ["ExecutorMismatch", "IntervalNotElapsed", "NonceReplay", "MinOutNotMet", "TriggerNotMet"]) {
      expect(ERRORS[name], name).toBeTruthy();
      expect(namedError(`execution reverted: ${name}()`)).toBe(name);
    }
  });

  it("returns null rather than guessing at an unknown message", () => {
    expect(namedError("connect ETIMEDOUT")).toBeNull();
    expect(namedError(undefined)).toBeNull();
    expect(namedError(42)).toBeNull();
  });
});
