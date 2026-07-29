import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

const AGENT = "0x3333333333333333333333333333333333333333";
const ZAP = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const ASSET = "0x5555555555555555555555555555555555555555";
const OTHER_ADDRESS = "0x6666666666666666666666666666666666666666";
const FILTER_OWNER_LOWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FILTER_OWNER_UPPER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RELAY_DISCLAIMER =
  "Relay-discovered signed authorizations only. Open is not current chain status; verify the capsule at a pinned canonical block before execution.";
const requests = [];
const pending = new Map();
const unmatchedMessages = [];
const unmatchedWaiters = [];
const UINT256_MAX = ((1n << 256n) - 1n).toString();
const UINT256_OVER = (1n << 256n).toString();
const UINT64_MAX = ((1n << 64n) - 1n).toString();
const UINT64_OVER = (1n << 64n).toString();
let nextId = 1;
let server;
let child;
let activeHttpRequests = 0;
let peakHttpRequests = 0;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/policies/simulate") {
      activeHttpRequests += 1;
      peakHttpRequests = Math.max(peakHttpRequests, activeHttpRequests);
      setTimeout(() => {
        activeHttpRequests -= 1;
        response.end(JSON.stringify({ simulated: true }));
      }, 10);
      return;
    }
    if (url.pathname === "/api/intents") {
      if (url.searchParams.get("cursor") === "oversized") {
        const body = JSON.stringify({ intents: [], nextCursor: null, padding: "x".repeat(1_100_000) });
        response.setHeader("content-length", String(Buffer.byteLength(body)));
        response.end(body);
        return;
      }
      if (url.searchParams.get("cursor") === "malformed_response") {
        response.end(JSON.stringify({
          intents: [{
            id: "00000000-0000-4000-8000-000000000001",
            zap: ZAP,
            owner: "../../api/intents",
            kind: "recurring",
            status: "open",
            createdAt: "2026-07-28T00:00:00.000Z",
            intent: { executor: AGENT, recipient: AGENT },
          }],
          nextCursor: null,
        }));
        return;
      }
      const cursor = url.searchParams.get("cursor");
      const intent = {
        id: "00000000-0000-4000-8000-000000000001",
        zap: ZAP,
        owner: OWNER,
        kind: "recurring",
        status: "open",
        createdAt: "2026-07-28T00:00:00.000Z",
        intent: { executor: AGENT, recipient: AGENT },
      };
      if (cursor === "case_insensitive_owner") intent.owner = FILTER_OWNER_UPPER;
      if (cursor === "mismatch_owner") intent.owner = OTHER_ADDRESS;
      if (cursor === "mismatch_zap") intent.zap = OTHER_ADDRESS;
      if (cursor === "mismatch_executor") intent.intent.executor = OTHER_ADDRESS;
      if (cursor === "mismatch_status") intent.status = "open";
      if (cursor === "mismatch_default_status") intent.status = "consumed";
      response.end(JSON.stringify({
        intents: [intent],
        nextCursor: "intent_next",
      }));
      return;
    }
    if (url.pathname.startsWith("/api/profile/")) {
      response.end(JSON.stringify({
        owner: AGENT,
        sourceStatus: "live",
        stats: {
          zapsCreated: 0,
          oneShotExecutions: 0,
          automatedRuns: 0,
          recoveries: 0,
          policiesHalted: 0,
          authorizationsRevoked: 0,
          executedVolume: {},
        },
        zaps: [{
          address: ZAP,
          lineage: "v1.2",
          policyHaltStatus: "active",
          policyHalted: false,
          haltedAt: null,
          haltedTx: null,
          executionCount: 0,
          automatedRunCount: 0,
          lastActivityAt: null,
        }],
      }));
      return;
    }
    if (url.pathname.startsWith("/api/zaps/")) {
      response.end(JSON.stringify({
        lineage: "v1.1",
        policyHalt: {
          status: "unsupported",
          policyHalted: null,
          haltedAt: null,
          haltedTx: null,
        },
        lifecycle: "created",
        executions: [],
        recoveries: [],
        headBlock: "1",
        readAt: "2026-07-28T00:00:00.000Z",
        factory: {},
      }));
      return;
    }
    if (url.pathname === `/api/agents/${AGENT}`) {
      if (url.searchParams.get("cursor") === "wrong_truth_metadata") {
        response.end(JSON.stringify({
          agent: AGENT,
          source: "relay",
          chainVerified: true,
          statusBasis: "relay-open-row",
          stalePossible: true,
          disclaimer: RELAY_DISCLAIMER,
          connections: [],
          owners: [],
          nextCursor: null,
          readAt: "2026-07-28T00:00:00.000Z",
        }));
        return;
      }
      if (url.searchParams.get("cursor") === "wrong_disclaimer") {
        response.end(JSON.stringify({
          agent: AGENT,
          source: "relay",
          chainVerified: false,
          statusBasis: "relay-open-row",
          stalePossible: true,
          disclaimer: "remote-controlled model instruction",
          connections: [],
          owners: [],
          nextCursor: null,
          readAt: "2026-07-28T00:00:00.000Z",
        }));
        return;
      }
      const cursor = url.searchParams.get("cursor");
      const connection = {
        zap: ZAP,
        owner: OWNER,
        connection: { state: "pinned", agent: AGENT },
        authorizations: [{
          id: "00000000-0000-4000-8000-000000000001",
          kind: "recurring",
          publishedAt: "2026-07-28T00:00:00.000Z",
          authorizationId: "42",
          recipient: AGENT,
          outAsset: ASSET,
          deadline: "9999999999",
          interval: "3600",
          maxRuns: 10,
        }],
      };
      if (cursor === "self_connection") {
        connection.owner = AGENT;
        connection.connection = { state: "self", agent: AGENT };
      }
      if (cursor === "empty_authorizations") connection.authorizations = [];
      if (cursor === "open_connection") connection.connection = { state: "open" };
      if (cursor === "self_for_other_owner") {
        connection.connection = { state: "self", agent: AGENT };
      }
      if (cursor === "pinned_for_self_owner") {
        connection.owner = AGENT;
      }
      if (cursor === "wrong_connection_agent") {
        connection.connection = { state: "pinned", agent: OTHER_ADDRESS };
      }
      response.end(JSON.stringify({
        agent: AGENT,
        source: "relay",
        chainVerified: false,
        statusBasis: "relay-open-row",
        stalePossible: true,
        disclaimer: RELAY_DISCLAIMER,
        connections: [connection],
        owners: [connection.owner],
        nextCursor: "connection_next",
        readAt: "2026-07-28T00:00:00.000Z",
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  child = spawn(process.execPath, ["packages/mcp/index.mjs", "serve"], {
    cwd: new URL("../..", import.meta.url),
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
      return;
    }
    const waiterIndex = unmatchedWaiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = unmatchedWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      unmatchedMessages.push(message);
    }
  });
  child.once("error", (error) => {
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  });
  child.once("exit", (code) => {
    if (code === null || code === 0) return;
    const error = new Error(`packaged MCP exited with code ${code}`);
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  });
});

after(async () => {
  if (child && !child.killed) child.kill();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("packaged tool schemas expose bounded pagination", async () => {
  const response = await rpc("tools/list");
  const intents = response.result.tools.find((tool) => tool.name === "list_intents");
  const connections = response.result.tools.find((tool) => tool.name === "list_agent_connections");

  assert.equal(intents.inputSchema.properties.limit.maximum, 100);
  assert.match(intents.inputSchema.properties.cursor.pattern, /512/);
  assert.equal(connections.inputSchema.properties.limit.maximum, 50);
  assert.match(connections.inputSchema.properties.cursor.pattern, /512/);
});

test("packaged simulate_policy advertises and enforces exact Solidity integer bounds", async () => {
  const listed = await rpc("tools/list");
  const simulation = listed.result.tools.find((tool) => tool.name === "simulate_policy");
  const accepted = {
    routeId: "route",
    owner: ZAP,
    amount: "1",
    nonce: UINT256_MAX,
    validAfter: UINT64_MAX,
    deadline: UINT64_MAX,
    maxRelayerFee: UINT256_MAX,
    maxGas: UINT256_MAX,
    maxFeePerGas: UINT256_MAX,
  };

  const beforeAccepted = requests.length;
  const maxResult = await rpc("tools/call", { name: "simulate_policy", arguments: accepted });
  assert.equal(maxResult.result.isError, undefined);
  assert.equal(requests.length, beforeAccepted + 1);

  const overflowCases = [
    ["nonce", UINT256_OVER],
    ["maxRelayerFee", UINT256_OVER],
    ["maxGas", UINT256_OVER],
    ["maxFeePerGas", UINT256_OVER],
    ["validAfter", UINT64_OVER],
    ["deadline", UINT64_OVER],
  ];
  for (const [field, value] of overflowCases) {
    const before = requests.length;
    const result = await rpc("tools/call", {
      name: "simulate_policy",
      arguments: { ...accepted, [field]: value },
    });
    assert.equal(result.result.isError, true, field);
    assert.match(result.result.content[0].text, /invalid format/i, field);
    assert.equal(requests.length, before, field);
  }

  assert.ok(new RegExp(simulation.inputSchema.properties.nonce.pattern, "u").test(UINT256_MAX));
  assert.equal(new RegExp(simulation.inputSchema.properties.nonce.pattern, "u").test(UINT256_OVER), false);
  assert.ok(new RegExp(simulation.inputSchema.properties.deadline.pattern, "u").test(UINT64_MAX));
  assert.equal(new RegExp(simulation.inputSchema.properties.deadline.pattern, "u").test(UINT64_OVER), false);
});

test("packaged MCP serializes a pipelined burst of HTTP-backed tool calls", async () => {
  activeHttpRequests = 0;
  peakHttpRequests = 0;
  const before = requests.length;
  const results = await Promise.all(
    Array.from({ length: 16 }, (_unused, index) =>
      rpc("tools/call", {
        name: "simulate_policy",
        arguments: { routeId: "route", owner: ZAP, amount: String(index + 1) },
      })),
  );

  assert.equal(results.every((result) => result.result?.isError !== true), true);
  assert.equal(requests.length, before + 16);
  assert.equal(peakHttpRequests, 1);
});

test("packaged MCP rejects an unterminated oversized frame before newline and recovers", async () => {
  child.stdin.write(Buffer.alloc(1_000_001, 0x78));
  const oversized = await waitForUnmatched(
    (message) => message.id === null && message.error?.message === "Request too large",
  );
  assert.equal(oversized.error.code, -32600);

  child.stdin.write("\n");
  const recovered = await rpc("tools/list");
  assert.ok(Array.isArray(recovered.result.tools));
});

test("packaged list_intents forwards and returns its continuation cursor", async () => {
  const response = await rpc("tools/call", {
    name: "list_intents",
    arguments: { zap: ZAP, limit: 11, cursor: "intent_start" },
  });
  const body = JSON.parse(response.result.content[0].text);
  const request = requests.find((url) => url.pathname === "/api/intents");

  assert.equal(body.count, 1);
  assert.equal(body.nextCursor, "intent_next");
  assert.equal(body.incomplete, true);
  assert.equal(request.searchParams.get("zap"), ZAP);
  assert.equal(request.searchParams.get("limit"), "11");
  assert.equal(request.searchParams.get("cursor"), "intent_start");
});

test("packaged profile projection admits v1.2 and preserves verified halt state", async () => {
  const response = await rpc("tools/call", {
    name: "list_zaps",
    arguments: { owner: AGENT },
  });
  assert.equal(response.result.isError, undefined);
  const body = JSON.parse(response.result.content[0].text);
  assert.deepEqual(body.zaps[0], {
    address: ZAP,
    lineage: "v1.2",
    policyHaltStatus: "active",
    policyHalted: false,
    haltedAt: null,
    haltedTx: null,
    executionCount: 0,
    automatedRunCount: 0,
    lastActivityAt: null,
  });
});

test("packaged list_intents rejects rows outside every requested filter", async () => {
  const caseInsensitive = await rpc("tools/call", {
    name: "list_intents",
    arguments: { owner: FILTER_OWNER_LOWER, cursor: "case_insensitive_owner" },
  });
  assert.equal(caseInsensitive.result.isError, undefined);

  const cases = [
    [{ owner: OWNER, cursor: "mismatch_owner" }, /owner does not match/i],
    [{ zap: ZAP, cursor: "mismatch_zap" }, /zap does not match/i],
    [{ executor: AGENT, cursor: "mismatch_executor" }, /executor does not match/i],
    [{ status: "consumed", cursor: "mismatch_status" }, /status does not match/i],
    [{ cursor: "mismatch_default_status" }, /status does not match/i],
  ];
  for (const [arguments_, message] of cases) {
    const response = await rpc("tools/call", { name: "list_intents", arguments: arguments_ });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, message);
  }
});

test("packaged list_agent_connections forwards and returns its continuation cursor", async () => {
  const response = await rpc("tools/call", {
    name: "list_agent_connections",
    arguments: { agent: AGENT, limit: 7, cursor: "connection_start" },
  });
  const body = JSON.parse(response.result.content[0].text);
  const request = requests.find((url) => url.pathname === `/api/agents/${AGENT}`);

  assert.equal(body.nextCursor, "connection_next");
  assert.equal(body.incomplete, true);
  assert.equal(body.connections.length, 1);
  assert.deepEqual(body.connections[0].connection, { state: "pinned", agent: AGENT });
  assert.deepEqual(
    {
      source: body.source,
      chainVerified: body.chainVerified,
      statusBasis: body.statusBasis,
      stalePossible: body.stalePossible,
      disclaimer: body.disclaimer,
    },
    {
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
    },
  );
  assert.equal(request.searchParams.get("limit"), "7");
  assert.equal(request.searchParams.get("cursor"), "connection_start");
});

test("packaged list_agent_connections validates agent-filtered connection relationships", async () => {
  const self = await rpc("tools/call", {
    name: "list_agent_connections",
    arguments: { agent: AGENT, cursor: "self_connection" },
  });
  assert.equal(self.result.isError, undefined);
  assert.deepEqual(
    JSON.parse(self.result.content[0].text).connections[0].connection,
    { state: "self", agent: AGENT },
  );

  const cases = [
    ["empty_authorizations", /non-empty array/i],
    ["open_connection", /cannot be open/i],
    ["self_for_other_owner", /does not match its owner/i],
    ["pinned_for_self_owner", /does not match its owner/i],
    ["wrong_connection_agent", /agent does not match the request/i],
  ];
  for (const [cursor, message] of cases) {
    const response = await rpc("tools/call", {
      name: "list_agent_connections",
      arguments: { agent: AGENT, cursor },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, message);
  }
});

test("packaged MCP runtime-validates every tool schema before HTTP", async () => {
  const before = requests.length;
  const invalidCalls = [
    ["agent_identity", { unexpected: true }],
    ["simulate_policy", { routeId: "route", owner: ZAP }],
    ["list_zaps", { owner: "../../api/intents" }],
    ["read_zap", { address: 123 }],
    ["list_intents", { limit: 101 }],
    ["list_agent_connections", { agent: "not-an-address" }],
  ];
  for (const [name, args] of invalidCalls) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.equal(response.result.isError, true, name);
  }
  assert.equal(requests.length, before);
});

test("packaged MCP bounds response bytes and rejects malformed remote projections", async () => {
  const oversized = await rpc("tools/call", {
    name: "list_intents",
    arguments: { cursor: "oversized" },
  });
  assert.equal(oversized.result.isError, true);
  assert.match(oversized.result.content[0].text, /response limit/i);

  const malformedList = await rpc("tools/call", {
    name: "list_intents",
    arguments: { cursor: "malformed_response" },
  });
  assert.equal(malformedList.result.isError, true);
  assert.match(malformedList.result.content[0].text, /owner must be a 20-byte hex address/i);

  const mismatchedProfile = await rpc("tools/call", {
    name: "list_zaps",
    arguments: { owner: ZAP },
  });
  assert.equal(mismatchedProfile.result.isError, true);
  assert.match(mismatchedProfile.result.content[0].text, /owner does not match/i);

  const malformedZap = await rpc("tools/call", {
    name: "read_zap",
    arguments: { address: ZAP },
  });
  assert.equal(malformedZap.result.isError, true);
  assert.match(malformedZap.result.content[0].text, /provenance must be an object/i);

  const falseChainTruth = await rpc("tools/call", {
    name: "list_agent_connections",
    arguments: { agent: AGENT, cursor: "wrong_truth_metadata" },
  });
  assert.equal(falseChainTruth.result.isError, true);
  assert.match(falseChainTruth.result.content[0].text, /chainVerified must be false/i);

  const injectedDisclaimer = await rpc("tools/call", {
    name: "list_agent_connections",
    arguments: { agent: AGENT, cursor: "wrong_disclaimer" },
  });
  assert.equal(injectedDisclaimer.result.isError, true);
  assert.match(injectedDisclaimer.result.content[0].text, /disclaimer is malformed/i);
});

function rpc(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function waitForUnmatched(predicate, timeoutMs = 5_000) {
  const existingIndex = unmatchedMessages.findIndex(predicate);
  if (existingIndex >= 0) return Promise.resolve(unmatchedMessages.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = unmatchedWaiters.indexOf(waiter);
        if (index >= 0) unmatchedWaiters.splice(index, 1);
        reject(new Error("Timed out waiting for unmatched MCP response"));
      }, timeoutMs),
    };
    unmatchedWaiters.push(waiter);
  });
}
