#!/usr/bin/env node

const PROTOCOL_VERSION = "2025-06-18";
const APP_URL = (process.env.OPENZAPS_APP_URL ?? "https://www.0xzaps.com").replace(/\/$/, "");
const AGENT_ADDRESS = readAddress(process.env.OPENZAPS_AGENT_ADDRESS);
const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT256_DECIMAL = {
  type: "string",
  maxLength: 78,
  pattern: decimalRangePattern((1n << 256n) - 1n),
};
const UINT64_DECIMAL = {
  type: "string",
  maxLength: 20,
  pattern: decimalRangePattern((1n << 64n) - 1n),
};
const CURSOR = { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" };
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const INTENT_DEFAULT_LIMIT = 50;
const INTENT_MAX_LIMIT = 100;
const CONNECTION_DEFAULT_LIMIT = 25;
const CONNECTION_MAX_LIMIT = 50;
const INTENT_STATUSES = new Set(["open", "consumed", "expired"]);
const INTENT_KINDS = new Set(["recurring", "recurring-relative", "recurring-stack", "trigger"]);
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_CONNECTION_DISCLAIMER =
  "Relay-discovered signed authorizations only. Open is not current chain status; verify the capsule at a pinned canonical block before execution.";
const MAX_RPC_FRAME_BYTES = 1_000_000;
const APP_RESPONSE_MAX_BYTES = 1_048_576;
const ERROR_RESPONSE_MAX_BYTES = 16_384;
const MODEL_ARRAY_MAX_ROWS = 200;
const MODEL_VALUE_MAX_DEPTH = 12;
const MODEL_VALUE_MAX_NODES = 5_000;
const MODEL_STRING_MAX_CHARS = 32_768;
const POLICY_HALT_STATUSES = new Set(["unsupported", "active", "halted", "unavailable"]);
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const TOOLS = [
  {
    name: "agent_identity",
    description:
      "Report the public agent address configured for discovery. This server never reads an executor key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: async () => ({
      mode: AGENT_ADDRESS ? "public-address" : "read-only",
      agentAddress: AGENT_ADDRESS,
      detail: AGENT_ADDRESS
        ? "This is a public identifier only. It is not a credential and grants no execution authority."
        : "No public agent address is configured. Discovery and simulation remain available.",
    }),
  },
  {
    name: "simulate_policy",
    description:
      "Compile and simulate an OpenZap policy from live state pinned to one block. Returns unsigned EIP-712 data and never signs or broadcasts.",
    inputSchema: {
      type: "object",
      required: ["routeId", "owner", "amount"],
      additionalProperties: false,
      properties: {
        routeId: { type: "string", minLength: 1, maxLength: 100 },
        owner: ADDRESS,
        recipient: ADDRESS,
        amount: { type: "string", pattern: "^[0-9]+(?:\\.[0-9]+)?$", maxLength: 100 },
        slippageBps: { type: "integer", minimum: 0, maximum: 5000 },
        nonce: UINT256_DECIMAL,
        validAfter: UINT64_DECIMAL,
        deadline: UINT64_DECIMAL,
        relayer: ADDRESS,
        maxRelayerFee: UINT256_DECIMAL,
        maxGas: UINT256_DECIMAL,
        maxFeePerGas: UINT256_DECIMAL,
      },
    },
    call: async (args) =>
      boundedModelValue(
        await app("/api/policies/simulate", { method: "POST", body: args }),
        "policy simulation response",
      ),
  },
  {
    name: "list_zaps",
    description: "List confirmed OpenZap capsules created by one wallet.",
    inputSchema: {
      type: "object",
      required: ["owner"],
      additionalProperties: false,
      properties: { owner: ADDRESS },
    },
    call: async ({ owner }) => {
      const checkedOwner = addressArg(owner, "owner");
      return projectProfile(await app(`/api/profile/${checkedOwner}`), checkedOwner);
    },
  },
  {
    name: "read_zap",
    description: "Read one capsule, its frozen policy, provenance, balances, and invariant deviations.",
    inputSchema: {
      type: "object",
      required: ["address"],
      additionalProperties: false,
      properties: { address: ADDRESS },
    },
    call: async ({ address }) => {
      const checkedAddress = addressArg(address, "address");
      return projectZapDetail(await app(`/api/zaps/${checkedAddress}`));
    },
  },
  {
    name: "list_intents",
    description:
      "List one bounded page of signed standing authorizations, filtered by owner, capsule, executor, or status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        owner: ADDRESS,
        zap: ADDRESS,
        executor: ADDRESS,
        status: { type: "string", enum: ["open", "consumed", "expired"] },
        limit: { type: "integer", minimum: 1, maximum: INTENT_MAX_LIMIT },
        cursor: CURSOR,
      },
    },
    call: async (args) => {
      const { limit, cursor } = paginationArgs(args, INTENT_DEFAULT_LIMIT, INTENT_MAX_LIMIT);
      const status = args.status ?? "open";
      if (!INTENT_STATUSES.has(status)) throw new Error("status is malformed.");
      const params = new URLSearchParams({
        status,
        limit: String(limit),
      });
      const requestedFilters = { status };
      for (const key of ["owner", "zap", "executor"]) {
        if (args[key] !== undefined) {
          const address = addressArg(args[key], key);
          params.set(key, address);
          requestedFilters[key] = address;
        }
      }
      if (cursor) params.set("cursor", cursor);
      const body = await app(`/api/intents?${params.toString()}`);
      if (!Array.isArray(body?.intents) || body.intents.length > limit) {
        throw new Error("Intent list returned an invalid page.");
      }
      const nextCursor = responseCursor(body, "Intent list");
      const intents = body.intents.map(projectIntentSummary);
      intents.forEach((intent, index) => assertIntentMatchesFilters(intent, requestedFilters, index));
      return {
        count: intents.length,
        intents,
        nextCursor,
        incomplete: nextCursor !== null,
      };
    },
  },
  {
    name: "list_agent_connections",
    description:
      "Read one bounded page of relay-listed authorizations that name a public agent address. Rows may be stale and are not chain-current authority; the address is not a credential.",
    inputSchema: {
      type: "object",
      required: ["agent"],
      additionalProperties: false,
      properties: {
        agent: ADDRESS,
        limit: { type: "integer", minimum: 1, maximum: CONNECTION_MAX_LIMIT },
        cursor: CURSOR,
      },
    },
    call: async ({ agent, ...args }) => {
      const checkedAgent = addressArg(agent, "agent");
      const { limit, cursor } = paginationArgs(args, CONNECTION_DEFAULT_LIMIT, CONNECTION_MAX_LIMIT);
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      const body = await app(`/api/agents/${checkedAgent}?${params.toString()}`);
      if (!Array.isArray(body?.connections) || body.connections.length > limit) {
        throw new Error("Connection list returned an invalid page.");
      }
      const nextCursor = responseCursor(body, "Connection list");
      return projectConnectionPage(body, checkedAgent, limit, nextCursor);
    },
  },
];

const instructions = `OpenZaps discovery and simulation only. This server cannot sign, publish,
relay, fund, revoke, or broadcast. Capsule/profile reads are public chain-derived data; intent and
connection lists are relay discovery rows that may be stale and are not proof of chain-current
authority. A run is authorized only by the capsule owner's EIP-712 signature and the capsule's
onchain checks. Never request a private key or seed phrase.`;

if (process.argv[2] === "tools") {
  process.stdout.write(`${JSON.stringify(TOOLS.map(({ name, description, inputSchema }) => ({ name, safety: "read-only", description, inputSchema })), null, 2)}\n`);
} else if (process.argv[2] === "identity") {
  process.stdout.write(`${JSON.stringify(await TOOLS[0].call({}), null, 2)}\n`);
} else if (process.argv[2] && process.argv[2] !== "serve") {
  process.stderr.write("Usage: openzaps-mcp [serve|identity|tools]\n");
  process.exitCode = 2;
} else {
  await serve();
}

async function serve() {
  let frameChunks = [];
  let frameBytes = 0;
  let discardingOversizedFrame = false;

  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;

    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const frameEnd = newline === -1 ? chunk.length : newline;
      const sliceBytes = frameEnd - offset;

      if (discardingOversizedFrame) {
        if (newline === -1) break;
        discardingOversizedFrame = false;
        offset = newline + 1;
        continue;
      }

      if (frameBytes + sliceBytes > MAX_RPC_FRAME_BYTES) {
        frameChunks = [];
        frameBytes = 0;
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
        if (newline === -1) {
          discardingOversizedFrame = true;
          break;
        }
        offset = newline + 1;
        continue;
      }

      if (sliceBytes > 0) {
        frameChunks.push(chunk.subarray(offset, frameEnd));
        frameBytes += sliceBytes;
      }
      if (newline === -1) break;

      const frame = Buffer.concat(frameChunks, frameBytes);
      frameChunks = [];
      frameBytes = 0;
      await handleFrame(frame);
      offset = newline + 1;
    }
  }

  // Preserve readline's prior EOF behavior for a final, bounded frame whose
  // sender closed stdin without a trailing newline.
  if (!discardingOversizedFrame && frameBytes > 0) {
    await handleFrame(Buffer.concat(frameChunks, frameBytes));
  }
}

async function handleFrame(rawFrame) {
  const frame = rawFrame.at(-1) === 0x0d ? rawFrame.subarray(0, -1) : rawFrame;
  let line;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  await handleLine(line);
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return write({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid request" } });
  }
  if (request.method === "notifications/initialized") return;
  if (request.id === undefined) return;

  try {
    if (request.method === "initialize") {
      return write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "openzaps", version: "0.1.0" },
          instructions,
        },
      });
    }
    if (request.method === "tools/list") {
      return write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      });
    }
    if (request.method === "tools/call") {
      const tool = TOOLS.find((candidate) => candidate.name === request.params?.name);
      if (!tool) throw new Error(`Unknown tool ${request.params?.name ?? ""}.`);
      const args =
        request.params && Object.prototype.hasOwnProperty.call(request.params, "arguments")
          ? request.params.arguments
          : {};
      validateToolArguments(tool.inputSchema, args);
      const value = await tool.call(args);
      return write({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] },
      });
    }
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed." }],
      },
    });
  }
}

async function app(path, options = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    method: options.method ?? "GET",
    cache: "no-store",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let body;
  try {
    body = await boundedResponseJson(
      response,
      response.ok ? APP_RESPONSE_MAX_BYTES : ERROR_RESPONSE_MAX_BYTES,
      path,
    );
  } catch (error) {
    if (response.ok) throw error;
    throw new Error(`${path} returned HTTP ${response.status} with an invalid or oversized error body.`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const detail =
      typeof body?.error === "string" && body.error.length <= 1_024
        ? body.error
        : `${path} returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return body;
}

async function boundedResponseJson(response, maxBytes, label) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte response limit.`);
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds the ${maxBytes}-byte response limit.`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function validateToolArguments(schema, value, path = "arguments") {
  if (!schema || typeof schema !== "object") throw new Error("Tool input schema is invalid.");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object.`);
    }
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        throw new Error(`${path}.${required} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(`${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateToolArguments(child, value[key], `${path}.${key}`);
      }
    }
    return value;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw new Error(`${path} is too short.`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw new Error(`${path} is too long.`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new Error(`${path} is not an allowed value.`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      throw new Error(`${path} has an invalid format.`);
    }
    return value;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer.`);
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new Error(`${path} is below the minimum.`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      throw new Error(`${path} exceeds the maximum.`);
    }
    return value;
  }
  throw new Error(`${path} uses an unsupported input schema.`);
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stringValue(value, label, maxLength, pattern = null) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || (pattern && !pattern.test(value))
  ) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function decimalValue(value, label) {
  return stringValue(value, label, 78, /^[0-9]+$/);
}

function timestampValue(value, label) {
  const timestamp = stringValue(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is not an ISO timestamp.`);
  return timestamp;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is malformed.`);
  return value;
}

function projectPolicyHalt(raw, lineage, label) {
  const halt = objectValue(raw, label);
  if (!POLICY_HALT_STATUSES.has(halt.status)) throw new Error(`${label}.status is malformed.`);
  if (halt.policyHalted !== null && typeof halt.policyHalted !== "boolean") {
    throw new Error(`${label}.policyHalted is malformed.`);
  }
  if (
    (halt.status === "unsupported" && (!["v1.1", "v3", "v3.1"].includes(lineage) || halt.policyHalted !== null))
    || (halt.status === "active" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== false))
    || (halt.status === "halted" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== true))
    || (halt.status === "unavailable" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== null))
  ) {
    throw new Error(`${label} contradicts the canonical lineage.`);
  }
  const haltedAt = halt.haltedAt === null
    ? null
    : nonnegativeInteger(halt.haltedAt, `${label}.haltedAt`);
  const haltedTx = halt.haltedTx === null
    ? null
    : stringValue(halt.haltedTx, `${label}.haltedTx`, 66, TX_HASH_PATTERN);
  if (halt.status === "halted" && (haltedAt === null || haltedTx === null)) {
    throw new Error(`${label} is missing canonical halt-event provenance.`);
  }
  if (
    (halt.status === "unsupported" || halt.status === "active")
    && (haltedAt !== null || haltedTx !== null)
  ) {
    throw new Error(`${label} carries halt-event provenance without a halted state.`);
  }
  if (halt.status === "unavailable" && (haltedAt === null) !== (haltedTx === null)) {
    throw new Error(`${label} carries incomplete halt-event provenance.`);
  }
  return { status: halt.status, policyHalted: halt.policyHalted, haltedAt, haltedTx };
}

function projectIntentSummary(record, index) {
  const row = objectValue(record, `Intent row ${index}`);
  const intent = objectValue(row.intent, `Intent row ${index}.intent`);
  if (!INTENT_KINDS.has(row.kind)) throw new Error(`Intent row ${index}.kind is malformed.`);
  if (!INTENT_STATUSES.has(row.status)) throw new Error(`Intent row ${index}.status is malformed.`);
  return {
    id: stringValue(row.id, `Intent row ${index}.id`, 36, RELAY_ID),
    zap: addressArg(row.zap, `Intent row ${index}.zap`),
    owner: addressArg(row.owner, `Intent row ${index}.owner`),
    kind: row.kind,
    status: row.status,
    createdAt: timestampValue(row.createdAt, `Intent row ${index}.createdAt`),
    executor: addressArg(intent.executor, `Intent row ${index}.intent.executor`),
    recipient: addressArg(intent.recipient, `Intent row ${index}.intent.recipient`),
  };
}

function assertIntentMatchesFilters(intent, requestedFilters, index) {
  if (intent.status !== requestedFilters.status) {
    throw new Error(`Intent row ${index}.status does not match the request.`);
  }
  for (const key of ["owner", "zap", "executor"]) {
    const requested = requestedFilters[key];
    if (requested && intent[key].toLowerCase() !== requested.toLowerCase()) {
      throw new Error(`Intent row ${index}.${key} does not match the request.`);
    }
  }
}

function projectProfile(profileRaw, requestedOwner) {
  const profile = objectValue(profileRaw, "Profile response");
  const owner = addressArg(profile.owner, "Profile owner");
  if (owner.toLowerCase() !== requestedOwner.toLowerCase()) {
    throw new Error("Profile owner does not match the request.");
  }
  if (!["live", "degraded"].includes(profile.sourceStatus)) {
    throw new Error("Profile sourceStatus is malformed.");
  }
  const stats = objectValue(profile.stats, "Profile stats");
  const executedVolume = objectValue(stats.executedVolume, "Profile executedVolume");
  if (Object.keys(executedVolume).length > 32) throw new Error("Profile executedVolume is too large.");
  if (!Array.isArray(profile.zaps) || profile.zaps.length > MODEL_ARRAY_MAX_ROWS) {
    throw new Error(`Profile must contain at most ${MODEL_ARRAY_MAX_ROWS} zaps.`);
  }
  return {
    owner,
    sourceStatus: profile.sourceStatus,
    stats: {
      zapsCreated: nonnegativeInteger(stats.zapsCreated, "Profile zapsCreated"),
      oneShotExecutions: nonnegativeInteger(stats.oneShotExecutions, "Profile oneShotExecutions"),
      automatedRuns: nonnegativeInteger(stats.automatedRuns, "Profile automatedRuns"),
      recoveries: nonnegativeInteger(stats.recoveries, "Profile recoveries"),
      policiesHalted: nonnegativeInteger(stats.policiesHalted, "Profile policiesHalted"),
      authorizationsRevoked: nonnegativeInteger(
        stats.authorizationsRevoked,
        "Profile authorizationsRevoked",
      ),
      executedVolume: Object.fromEntries(
        Object.entries(executedVolume).map(([symbol, amount]) => [
          stringValue(symbol, "Profile volume symbol", 64),
          decimalValue(amount, `Profile volume ${symbol}`),
        ]),
      ),
    },
    zaps: profile.zaps.map((zapRaw, index) => {
      const zap = objectValue(zapRaw, `Profile zap ${index}`);
      if (!["v1.1", "v1.2", "v3", "v3.1", "v3.2"].includes(zap.lineage)) {
        throw new Error(`Profile zap ${index}.lineage is malformed.`);
      }
      const policyHalt = projectPolicyHalt(
        {
          status: zap.policyHaltStatus,
          policyHalted: zap.policyHalted,
          haltedAt: zap.haltedAt,
          haltedTx: zap.haltedTx,
        },
        zap.lineage,
        `Profile zap ${index}.policyHalt`,
      );
      return {
        address: addressArg(zap.address, `Profile zap ${index}.address`),
        lineage: zap.lineage,
        policyHaltStatus: policyHalt.status,
        policyHalted: policyHalt.policyHalted,
        haltedAt: policyHalt.haltedAt,
        haltedTx: policyHalt.haltedTx,
        executionCount: nonnegativeInteger(zap.executionCount, `Profile zap ${index}.executionCount`),
        automatedRunCount: nonnegativeInteger(
          zap.automatedRunCount,
          `Profile zap ${index}.automatedRunCount`,
        ),
        lastActivityAt:
          zap.lastActivityAt === null
            ? null
            : nonnegativeInteger(zap.lastActivityAt, `Profile zap ${index}.lastActivityAt`),
      };
    }),
  };
}

function projectConnectionPage(bodyRaw, requestedAgent, limit, nextCursor) {
  const body = objectValue(bodyRaw, "Connection response");
  const agent = addressArg(body.agent, "Connection agent");
  if (agent.toLowerCase() !== requestedAgent.toLowerCase()) {
    throw new Error("Connection agent does not match the request.");
  }
  if (!Array.isArray(body.connections) || body.connections.length > limit) {
    throw new Error("Connection list returned an invalid page.");
  }
  const relayTruth = relayTruthMetadata(body, "Connection response");
  let authorizationCount = 0;
  const connections = body.connections.map((connectionRaw, index) => {
    const row = objectValue(connectionRaw, `Connection row ${index}`);
    const zap = addressArg(row.zap, `Connection row ${index}.zap`);
    const owner = addressArg(row.owner, `Connection row ${index}.owner`);
    const connection = objectValue(row.connection, `Connection row ${index}.connection`);
    if (!["open", "self", "pinned"].includes(connection.state)) {
      throw new Error(`Connection row ${index}.state is malformed.`);
    }
    if (connection.state === "open") {
      throw new Error(`Connection row ${index}.state cannot be open for an agent-filtered response.`);
    }
    const expectedState =
      owner.toLowerCase() === requestedAgent.toLowerCase() ? "self" : "pinned";
    if (connection.state !== expectedState) {
      throw new Error(`Connection row ${index}.state does not match its owner and requested agent.`);
    }
    const connectionAgent = addressArg(
      connection.agent,
      `Connection row ${index}.connection.agent`,
    );
    if (connectionAgent.toLowerCase() !== requestedAgent.toLowerCase()) {
      throw new Error(`Connection row ${index}.connection.agent does not match the request.`);
    }
    if (!Array.isArray(row.authorizations) || row.authorizations.length === 0) {
      throw new Error(`Connection row ${index}.authorizations must be a non-empty array.`);
    }
    authorizationCount += row.authorizations.length;
    if (authorizationCount > limit) throw new Error("Connection response contains too many authorizations.");
    return {
      zap,
      owner,
      connection: {
        state: connection.state,
        agent: connectionAgent,
      },
      authorizations: row.authorizations.map((authorizationRaw, authorizationIndex) => {
        const label = `Connection row ${index}.authorization ${authorizationIndex}`;
        const authorization = objectValue(authorizationRaw, label);
        if (!INTENT_KINDS.has(authorization.kind)) throw new Error(`${label}.kind is malformed.`);
        return {
          id: stringValue(authorization.id, `${label}.id`, 36, RELAY_ID),
          kind: authorization.kind,
          publishedAt: timestampValue(authorization.publishedAt, `${label}.publishedAt`),
          authorizationId: decimalValue(authorization.authorizationId, `${label}.authorizationId`),
          recipient: addressArg(authorization.recipient, `${label}.recipient`),
          outAsset: addressArg(authorization.outAsset, `${label}.outAsset`),
          deadline: decimalValue(authorization.deadline, `${label}.deadline`),
          interval:
            authorization.interval === null
              ? null
              : decimalValue(authorization.interval, `${label}.interval`),
          maxRuns:
            authorization.maxRuns === null
              ? null
              : nonnegativeInteger(authorization.maxRuns, `${label}.maxRuns`),
        };
      }),
    };
  });
  return {
    agent,
    ...relayTruth,
    connections,
    owners: [
      ...new Map(connections.map((row) => [row.owner.toLowerCase(), row.owner])).values(),
    ],
    nextCursor,
    incomplete: nextCursor !== null,
    readAt: timestampValue(body.readAt, "Connection readAt"),
  };
}

function relayTruthMetadata(body, label) {
  if (body.source !== "relay") throw new Error(`${label}.source must be relay.`);
  if (body.chainVerified !== false) throw new Error(`${label}.chainVerified must be false.`);
  if (body.statusBasis !== "relay-open-row") {
    throw new Error(`${label}.statusBasis must be relay-open-row.`);
  }
  if (body.stalePossible !== true) throw new Error(`${label}.stalePossible must be true.`);
  if (body.disclaimer !== RELAY_CONNECTION_DISCLAIMER) {
    throw new Error(`${label}.disclaimer is malformed.`);
  }
  return {
    source: "relay",
    chainVerified: false,
    statusBasis: "relay-open-row",
    stalePossible: true,
    disclaimer: RELAY_CONNECTION_DISCLAIMER,
  };
}

function boundedModelValue(value, label, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MODEL_VALUE_MAX_NODES) throw new Error(`${label} contains too many values.`);
  if (depth > MODEL_VALUE_MAX_DEPTH) throw new Error(`${label} is nested too deeply.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MODEL_STRING_MAX_CHARS) throw new Error(`${label} contains an oversized string.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MODEL_ARRAY_MAX_ROWS) throw new Error(`${label} contains too many rows.`);
    return value.map((entry, index) => boundedModelValue(entry, `${label}[${index}]`, state, depth + 1));
  }
  const object = objectValue(value, label);
  const entries = Object.entries(object);
  if (entries.length > 200) throw new Error(`${label} contains too many fields.`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      stringValue(key, `${label} field name`, 128),
      boundedModelValue(entry, `${label}.${key}`, state, depth + 1),
    ]),
  );
}

function projectZapDetail(detailRaw) {
  const detail = objectValue(detailRaw, "Zap response");
  if (!["v1.1", "v1.2", "v3", "v3.1", "v3.2"].includes(detail.lineage)) {
    throw new Error("Zap lineage is malformed.");
  }
  if (!["created", "funded", "executed", "recovered"].includes(detail.lifecycle)) {
    throw new Error("Zap lifecycle is malformed.");
  }
  if (!Array.isArray(detail.executions) || detail.executions.length > MODEL_ARRAY_MAX_ROWS) {
    throw new Error(`Zap response must contain at most ${MODEL_ARRAY_MAX_ROWS} executions.`);
  }
  if (!Array.isArray(detail.recoveries) || detail.recoveries.length > MODEL_ARRAY_MAX_ROWS) {
    throw new Error(`Zap response must contain at most ${MODEL_ARRAY_MAX_ROWS} recoveries.`);
  }
  return {
    lineage: detail.lineage,
    provenance: boundedModelValue(objectValue(detail.provenance, "Zap provenance"), "Zap provenance"),
    policy: boundedModelValue(objectValue(detail.policy, "Zap policy"), "Zap policy"),
    policyHalt: projectPolicyHalt(detail.policyHalt, detail.lineage, "Zap policyHalt"),
    stats: boundedModelValue(objectValue(detail.stats, "Zap stats"), "Zap stats"),
    balances: boundedModelValue(objectValue(detail.balances, "Zap balances"), "Zap balances"),
    executions: boundedModelValue(detail.executions, "Zap executions"),
    recoveries: boundedModelValue(detail.recoveries, "Zap recoveries"),
    lifecycle: detail.lifecycle,
    headBlock: decimalValue(detail.headBlock, "Zap headBlock"),
    readAt: timestampValue(detail.readAt, "Zap readAt"),
    factory: boundedModelValue(objectValue(detail.factory, "Zap factory"), "Zap factory"),
  };
}

function paginationArgs(args, defaultLimit, maxLimit) {
  const limit = args.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`limit must be an integer from 1 to ${maxLimit}.`);
  }
  const cursor = args.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor))) {
    throw new Error("cursor is malformed.");
  }
  return { limit, cursor };
}

function responseCursor(body, label) {
  const value = body?.nextCursor;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CURSOR_PATTERN.test(value)) {
    throw new Error(`${label} returned a malformed cursor.`);
  }
  return value;
}

function addressArg(value, label) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} must be a 20-byte hex address.`);
  }
  return value;
}

function readAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value) ? value : null;
}

/**
 * Build a JSON-Schema-compatible regex for canonical decimal integers in [0, maximum].
 * Length-only uint patterns accept some 78/20-digit values above Solidity's uint256/uint64 maxima.
 */
function decimalRangePattern(maximum) {
  const max = BigInt(maximum).toString();
  const alternatives = ["0"];
  if (max.length > 1) alternatives.push(`[1-9][0-9]{0,${max.length - 2}}`);
  for (let index = 0; index < max.length; index += 1) {
    const digit = Number(max[index]);
    const low = index === 0 ? 1 : 0;
    const high = digit - 1;
    if (high < low) continue;
    const choice = low === high ? String(low) : `[${low}-${high}]`;
    const remaining = max.length - index - 1;
    alternatives.push(`${max.slice(0, index)}${choice}${remaining > 0 ? `[0-9]{${remaining}}` : ""}`);
  }
  alternatives.push(max);
  return `^(?:${alternatives.join("|")})$`;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
