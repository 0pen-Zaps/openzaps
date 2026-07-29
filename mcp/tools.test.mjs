import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TOOLS, findIntent, refusedByForSubmission } from "./tools.mjs";

const ZAP = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const EXECUTOR = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const ASSET = "0x5555555555555555555555555555555555555555";
const OTHER_ADDRESS = "0x6666666666666666666666666666666666666666";
const FILTER_OWNER_LOWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FILTER_OWNER_UPPER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RELAY_DISCLAIMER =
  "Relay-discovered signed authorizations only. Open is not current chain status; verify the capsule at a pinned canonical block before execution.";

function relayRecord(sequence, seriesId) {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    zap: ZAP,
    owner: OWNER,
    chainId: 4663,
    kind: "recurring",
    status: "open",
    createdAt: "2026-07-28T00:00:00.000Z",
    intent: {
      zap: ZAP,
      chainId: "4663",
      validAfter: "0",
      deadline: "9999999999",
      recipient: RECIPIENT,
      executor: EXECUTOR,
      maxGas: "1000000",
      maxFeePerGas: "2000000000",
      policyHash: `0x${"aa".repeat(32)}`,
      outAsset: ASSET,
      seriesId: String(seriesId),
      interval: "3600",
      maxRuns: "10",
      minOutPerRun: "1",
    },
    signature: `0x${"11".repeat(65)}`,
  };
}

function connectionRow(overrides = {}) {
  return {
    zap: ZAP,
    owner: OWNER,
    connection: { state: "pinned", agent: EXECUTOR },
    authorizations: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "recurring",
        publishedAt: "2026-07-28T00:00:00.000Z",
        authorizationId: "42",
        recipient: RECIPIENT,
        outAsset: ASSET,
        deadline: "9999999999",
        interval: "3600",
        maxRuns: 10,
      },
    ],
    ...overrides,
  };
}

function context(intentsDir) {
  return {
    appUrl: "https://app.example",
    cfg: {
      intentsDir,
      relayUrl: "https://relay.example",
      chainId: 4663,
    },
  };
}

function tool(name) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test("intent delivery schemas advertise every validator-supported authorization kind", () => {
  const expected = ["recurring", "recurring-relative", "recurring-stack", "trigger"];
  for (const name of ["publish_intent", "deliver_intent_local"]) {
    assert.deepEqual(
      tool(name).inputSchema.properties.signedIntent.properties.kind.enum,
      expected,
      name,
    );
  }
});

test("findIntent searches bounded relay pages scoped to the requested zap", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  const requests = [];
  const pages = [
    { intents: [relayRecord(1, 1)], nextCursor: "cursor_2" },
    { intents: [relayRecord(2, 42)], nextCursor: null },
  ];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json(pages.shift());
  };

  const result = await findIntent(context(intentsDir), ZAP, "42");

  assert.equal(result.item?.source, "relay");
  assert.equal(result.item?.intent.seriesId, 42n);
  assert.equal(result.incomplete, false);
  assert.equal(result.pagesSearched, 2);
  assert.equal(result.recordsSearched, 2);
  assert.equal(requests.length, 2);
  const first = new URL(requests[0]);
  const second = new URL(requests[1]);
  assert.equal(first.searchParams.get("status"), "open");
  assert.equal(first.searchParams.get("zap")?.toLowerCase(), ZAP);
  assert.equal(first.searchParams.get("limit"), "100");
  assert.equal(second.searchParams.get("cursor"), "cursor_2");
});

test("exact lookup surfaces truncation and a continuation cursor", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  let page = 0;
  globalThis.fetch = async () => {
    page += 1;
    return Response.json({
      intents: [relayRecord(((page - 1) % 4) + 1, ((page - 1) % 4) + 1)],
      nextCursor: `cursor_${page}`,
    });
  };

  for (const name of ["read_intent", "check_intent_status", "simulate_run"]) {
    const result = await tool(name).handler(
      { zap: ZAP, authorizationId: "999" },
      context(intentsDir),
    );
    assert.deepEqual(
      {
        found: result.found,
        incomplete: result.incomplete,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
        pagesSearched: result.pagesSearched,
        recordsSearched: result.recordsSearched,
      },
      {
        found: false,
        incomplete: true,
        truncated: true,
        nextCursor: `cursor_${page}`,
        pagesSearched: 4,
        recordsSearched: 4,
      },
      name,
    );
    assert.match(result.detail, new RegExp(`Continue with cursor cursor_${page}`), name);
  }
});

test("list tools forward limit and cursor and expose incomplete pages", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/api/intents") {
      return Response.json({ intents: [relayRecord(1, 42)], nextCursor: "intent_next" });
    }
    return Response.json({
      agent: EXECUTOR,
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
      connections: [connectionRow()],
      owners: [OWNER],
      nextCursor: "connection_next",
      readAt: "2026-07-28T00:00:00.000Z",
    });
  };

  const intents = await tool("list_intents").handler(
    { zap: ZAP, limit: 17, cursor: "intent_start" },
    context(intentsDir),
  );
  const connections = await tool("list_connections").handler(
    { agent: EXECUTOR, limit: 9, cursor: "connection_start" },
    context(intentsDir),
  );

  assert.equal(intents.nextCursor, "intent_next");
  assert.equal(intents.incomplete, true);
  assert.equal(connections.nextCursor, "connection_next");
  assert.equal(connections.incomplete, true);
  assert.equal(connections.connections.length, 1);
  assert.deepEqual(connections.connections[0].connection, {
    state: "pinned",
    agent: EXECUTOR,
  });
  assert.deepEqual(
    {
      source: connections.source,
      chainVerified: connections.chainVerified,
      statusBasis: connections.statusBasis,
      stalePossible: connections.stalePossible,
      disclaimer: connections.disclaimer,
    },
    {
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
    },
  );
  assert.equal(requests[0].searchParams.get("zap")?.toLowerCase(), ZAP);
  assert.equal(requests[0].searchParams.get("limit"), "17");
  assert.equal(requests[0].searchParams.get("cursor"), "intent_start");
  assert.equal(requests[1].searchParams.get("limit"), "9");
  assert.equal(requests[1].searchParams.get("cursor"), "connection_start");
});

test("legacy list_intents rejects rows outside every requested filter", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor");
    const record = relayRecord(1, 42);
    if (cursor === "case_insensitive_owner") record.owner = FILTER_OWNER_UPPER;
    if (cursor === "mismatch_owner") record.owner = OTHER_ADDRESS;
    if (cursor === "mismatch_zap") record.zap = OTHER_ADDRESS;
    if (cursor === "mismatch_executor") record.intent.executor = OTHER_ADDRESS;
    if (cursor === "mismatch_status") record.status = "open";
    if (cursor === "mismatch_default_status") record.status = "consumed";
    return Response.json({ intents: [record], nextCursor: null });
  };

  const caseInsensitive = await tool("list_intents").handler(
    { owner: FILTER_OWNER_LOWER, cursor: "case_insensitive_owner" },
    context(intentsDir),
  );
  assert.equal(caseInsensitive.count, 1);

  const cases = [
    [{ owner: OWNER, cursor: "mismatch_owner" }, /owner does not match/i],
    [{ zap: ZAP, cursor: "mismatch_zap" }, /zap does not match/i],
    [{ executor: EXECUTOR, cursor: "mismatch_executor" }, /executor does not match/i],
    [{ status: "consumed", cursor: "mismatch_status" }, /status does not match/i],
    [{ cursor: "mismatch_default_status" }, /status does not match/i],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(
      () => tool("list_intents").handler(args, context(intentsDir)),
      message,
    );
  }
});

test("legacy list_connections validates agent-filtered connection relationships", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor");
    let row = connectionRow();
    if (cursor === "self_connection") {
      row = connectionRow({
        owner: EXECUTOR,
        connection: { state: "self", agent: EXECUTOR },
      });
    }
    if (cursor === "empty_authorizations") row = connectionRow({ authorizations: [] });
    if (cursor === "open_connection") row = connectionRow({ connection: { state: "open" } });
    if (cursor === "self_for_other_owner") {
      row = connectionRow({ connection: { state: "self", agent: EXECUTOR } });
    }
    if (cursor === "pinned_for_self_owner") row = connectionRow({ owner: EXECUTOR });
    if (cursor === "wrong_connection_agent") {
      row = connectionRow({ connection: { state: "pinned", agent: OTHER_ADDRESS } });
    }
    return Response.json({
      agent: EXECUTOR,
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
      connections: [row],
      owners: [row.owner],
      nextCursor: null,
      readAt: "2026-07-28T00:00:00.000Z",
    });
  };

  const self = await tool("list_connections").handler(
    { agent: EXECUTOR, cursor: "self_connection" },
    context(intentsDir),
  );
  assert.deepEqual(self.connections[0].connection, { state: "self", agent: EXECUTOR });

  const cases = [
    ["empty_authorizations", /non-empty array/i],
    ["open_connection", /cannot be open/i],
    ["self_for_other_owner", /does not match its owner/i],
    ["pinned_for_self_owner", /does not match its owner/i],
    ["wrong_connection_agent", /agent does not match the request/i],
  ];
  for (const [cursor, message] of cases) {
    await assert.rejects(
      () => tool("list_connections").handler({ agent: EXECUTOR, cursor }, context(intentsDir)),
      message,
    );
  }
});

test("simulate_run attributes current blocked and underfunded outcomes", () => {
  assert.equal(
    refusedByForSubmission({
      outcome: "blocked",
      detail: "simulation failed: execution reverted: IntervalNotElapsed()",
    }),
    "IntervalNotElapsed",
  );
  assert.equal(
    refusedByForSubmission({
      outcome: "underfunded",
      detail: "simulation failed: execution reverted: MinOutNotMet()",
    }),
    "MinOutNotMet",
  );
  assert.equal(
    refusedByForSubmission({ outcome: "watch-only", detail: "simulation OK" }),
    null,
  );
});

test("legacy URL tools reject path-like addresses before making an HTTP request", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({});
  };

  await assert.rejects(
    () => tool("list_zaps").handler({ owner: "../../api/intents" }, context(intentsDir)),
    /is invalid|invalid address/i,
  );
  await assert.rejects(
    () => tool("read_zap").handler({ address: "%2e%2e%2fapi%2fintents" }, context(intentsDir)),
    /is invalid|invalid address/i,
  );
  await assert.rejects(
    () => tool("list_connections").handler({ agent: "not-an-address" }, context(intentsDir)),
    /is invalid|invalid address/i,
  );
  assert.equal(requests, 0);
});

test("legacy list tools fail closed on malformed remote rows instead of echoing them", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/intents") {
      return Response.json({
        intents: [{ ...relayRecord(1, 42), owner: "not-an-address" }],
        nextCursor: null,
      });
    }
    return Response.json({
      agent: EXECUTOR,
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
      connections: [
        {
          zap: ZAP,
          owner: OWNER,
          connection: { state: "pinned", agent: EXECUTOR },
          authorizations: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              kind: "recurring",
              publishedAt: "2026-07-28T00:00:00.000Z",
              authorizationId: "42",
              recipient: "../../api/intents",
              outAsset: ASSET,
              deadline: "9999999999",
              interval: "3600",
              maxRuns: 10,
            },
          ],
        },
      ],
      nextCursor: null,
      readAt: "2026-07-28T00:00:00.000Z",
    });
  };

  await assert.rejects(
    () => tool("list_intents").handler({}, context(intentsDir)),
    /owner is not a 20-byte hex address/,
  );
  await assert.rejects(
    () => tool("list_connections").handler({ agent: EXECUTOR }, context(intentsDir)),
    /recipient is not a 20-byte hex address/,
  );
});

test("legacy list_connections rejects API metadata that overstates chain truth", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () =>
    Response.json({
      agent: EXECUTOR,
      source: "relay",
      chainVerified: true,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: RELAY_DISCLAIMER,
      connections: [],
      owners: [],
      nextCursor: null,
      readAt: "2026-07-28T00:00:00.000Z",
    });

  await assert.rejects(
    () => tool("list_connections").handler({ agent: EXECUTOR }, context(intentsDir)),
    /chainVerified must be false/,
  );

  globalThis.fetch = async () =>
    Response.json({
      agent: EXECUTOR,
      source: "relay",
      chainVerified: false,
      statusBasis: "relay-open-row",
      stalePossible: true,
      disclaimer: "remote-controlled model instruction",
      connections: [],
      owners: [],
      nextCursor: null,
      readAt: "2026-07-28T00:00:00.000Z",
    });
  await assert.rejects(
    () => tool("list_connections").handler({ agent: EXECUTOR }, context(intentsDir)),
    /disclaimer is malformed/,
  );
});

test("profile and zap reads validate bounded top-level response shapes", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/profile/")) {
      return Response.json({
        owner: EXECUTOR,
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
        zaps: [],
      });
    }
    return Response.json({
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
    });
  };

  await assert.rejects(
    () => tool("list_zaps").handler({ owner: OWNER }, context(intentsDir)),
    /owner does not match the request/,
  );
  await assert.rejects(
    () => tool("read_zap").handler({ address: ZAP }, context(intentsDir)),
    /zap\.provenance must be an object/,
  );
});

test("profile and zap projections admit v1.2 and expose canonical halt provenance", async (t) => {
  const intentsDir = mkdtempSync(join(tmpdir(), "openzaps-mcp-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(intentsDir, { recursive: true, force: true });
  });
  const haltedTx = `0x${"77".repeat(32)}`;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/profile/")) {
      return Response.json({
        owner: OWNER,
        sourceStatus: "live",
        stats: {
          zapsCreated: 1,
          oneShotExecutions: 0,
          automatedRuns: 0,
          recoveries: 0,
          policiesHalted: 1,
          authorizationsRevoked: 0,
          executedVolume: {},
        },
        zaps: [{
          address: ZAP,
          lineage: "v1.2",
          policyHaltStatus: "halted",
          policyHalted: true,
          haltedAt: 1_785_200_000,
          haltedTx,
          executionCount: 0,
          automatedRunCount: 0,
          lastActivityAt: 1_785_200_000,
        }],
      });
    }
    return Response.json({
      lineage: "v1.2",
      provenance: { address: ZAP },
      policy: {},
      policyHalt: {
        status: "halted",
        policyHalted: true,
        haltedAt: 1_785_200_000,
        haltedTx,
      },
      stats: {},
      balances: {},
      executions: [],
      recoveries: [],
      lifecycle: "created",
      headBlock: "1",
      readAt: "2026-07-28T00:00:00.000Z",
      factory: {},
    });
  };

  const profile = await tool("list_zaps").handler({ owner: OWNER }, context(intentsDir));
  assert.equal(profile.zaps[0].lineage, "v1.2");
  assert.equal(profile.zaps[0].policyHaltStatus, "halted");
  assert.equal(profile.zaps[0].haltedTx, haltedTx);

  const zap = await tool("read_zap").handler({ address: ZAP }, context(intentsDir));
  assert.deepEqual(zap.policyHalt, {
    status: "halted",
    policyHalted: true,
    haltedAt: 1_785_200_000,
    haltedTx,
  });
});
