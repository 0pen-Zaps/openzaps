import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const requests = [];
const pending = new Map();
let nextId = 1;
let server;
let child;

before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  child = spawn(process.execPath, ["mcp/index.mjs", "serve"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      OPENZAPS_APP_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle.resolve(message);
    }
  });
  child.once("error", (error) => {
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  });
});

after(async () => {
  if (child && !child.killed) child.kill();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("legacy MCP runtime-validates every tool schema before context or HTTP", async () => {
  const invalidCalls = [
    ["agent_identity", { unexpected: true }],
    ["list_zaps", { owner: "../../api/intents" }],
    ["read_zap", {}],
    ["explain_policy", { address: 123 }],
    ["list_intents", { limit: 101 }],
    ["read_intent", { zap: ADDRESS, authorizationId: 1 }],
    ["check_intent_status", { zap: ADDRESS, authorizationId: "1", cursor: "***" }],
    ["simulate_run", { zap: ADDRESS, authorizationId: "1", unexpected: true }],
    ["list_connections", { agent: "not-an-address" }],
    ["draft_intent", { zap: ADDRESS, mode: "drain" }],
    ["publish_intent", { signedIntent: { kind: "trigger", intent: {}, signature: "0x" } }],
    ["deliver_intent_local", { signedIntent: null }],
    ["explain_error", { error: "x".repeat(2_049) }],
  ];

  for (const [name, args] of invalidCalls) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.equal(response.result?.isError, true, name);
    assert.match(response.result.content[0].text, /failed:/, name);
  }
  assert.deepEqual(requests, []);
});

function rpc(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
