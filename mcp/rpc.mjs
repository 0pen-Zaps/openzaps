// Minimal MCP server over stdio.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0 — one message per line, no framing
// headers. The four methods a tool server actually needs (`initialize`, `notifications/initialized`,
// `tools/list`, `tools/call`) fit in this file, which is why there is no SDK dependency here: this
// process runs on a user's machine with filesystem access, and the whole app it serves has five
// production dependencies. Adding zod + express + cors + eventsource to expose ten read-only tools
// would be the largest supply-chain expansion in the repo, spent on code we can write once.
//
// THE ONE RULE: stdout carries protocol frames and nothing else. Every log, warning and stack trace
// goes to stderr. A stray console.log here corrupts the stream and the client sees a parse error
// with no obvious cause.
import { createInterface } from "node:readline";

/** The MCP revision this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export function logStderr(message) {
  process.stderr.write(`[openzaps-mcp] ${message}\n`);
}

/**
 * Run the server loop until stdin closes.
 *
 * @param {object} options
 * @param {{name: string, version: string}} options.serverInfo
 * @param {string} options.instructions Shown to the MODEL on connect — this is where the
 *   server's limits are stated, because a limit the model cannot read is a limit it will
 *   try to work around.
 * @param {Array<object>} options.tools
 * @param {() => Promise<object>} options.context Lazily built per call, so a bad config
 *   surfaces as one tool error rather than a server that will not start.
 */
export async function serve({ serverInfo, instructions, tools, context }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (message) => {
    const { id, method, params } = message;
    // A notification has no id and MUST NOT be answered.
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions,
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return; // Nothing to do, and nothing to answer.

      case "ping":
        return reply(id, {});

      case "tools/list":
        return reply(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            // The safety class is part of what the model reads, not just an
            // internal label — "read-only" in the description is the difference
            // between an agent that simulates and one that asks a human first.
            description: `[${tool.safety}] ${tool.description}`,
            inputSchema: tool.inputSchema,
          })),
        });

      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, METHOD_NOT_FOUND, `Unknown tool: ${params?.name}`);
        try {
          const ctx = await context();
          const result = await tool.handler(params?.arguments ?? {}, ctx);
          return reply(id, {
            content: [{ type: "text", text: typeof result === "string" ? result : stringify(result) }],
          });
        } catch (error) {
          // A tool failure is a RESULT, not a protocol error: the model should
          // see why and adapt, rather than the client treating the server as
          // broken. isError is how MCP says "this call failed" in-band.
          return reply(id, {
            content: [{ type: "text", text: `${tool.name} failed: ${error?.message ?? String(error)}` }],
            isError: true,
          });
        }
      }

      default:
        if (isNotification) return;
        return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  };

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      fail(null, PARSE_ERROR, "Message was not valid JSON.");
      continue;
    }
    if (typeof message !== "object" || message === null || typeof message.method !== "string") {
      fail(message?.id ?? null, INVALID_REQUEST, "Message was not a JSON-RPC request.");
      continue;
    }

    try {
      await handle(message);
    } catch (error) {
      logStderr(`dispatch failed: ${error?.stack ?? error}`);
      if (message.id !== undefined && message.id !== null) {
        fail(message.id, INTERNAL_ERROR, error?.message ?? "Internal error.");
      }
    }
  }
}

/** BigInts are pervasive in this domain and JSON.stringify throws on them. */
export function stringify(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
