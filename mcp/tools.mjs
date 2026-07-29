// The tool table.
//
// Every tool declares a SAFETY CLASS, and the classes are the whole design:
//
//   read-only  changes nothing, anywhere
//   publish    moves an artifact the owner ALREADY signed; cannot create authority
//
// There is deliberately no third class. Nothing in this server broadcasts a transaction, holds a
// key, or signs. That is not a policy we enforce with care — it is enforced by not importing a
// wallet client, and by calling submitExecution with a null signer, which makes broadcasting
// structurally unreachable rather than merely unintended.
//
// The reason this is safe to hand an agent at all: onchain, an agent's authority is exactly one
// field of an owner-signed intent —
//
//     if (intent.executor != address(0) && msg.sender != intent.executor) revert ExecutorMismatch();
//
// so the worst a fully compromised agent achieves is submitting a run the capsule already owes, or
// refusing to submit one.
import { readFileSync } from "node:fs";
import { getAddress, isAddressEqual, zeroAddress } from "viem";

import { evaluateRecurring, evaluateTrigger, submitExecution } from "../executor/engine.mjs";
import { loadIntents, validateIntentObject } from "../executor/store.mjs";
import { appGet, boundedResponseJson } from "./config.mjs";

export const READ_ONLY = "read-only";
export const PUBLISH = "publish";

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const UINT = { type: "string", pattern: "^[0-9]{1,78}$" };
const UINT_PATTERN = /^[0-9]{1,78}$/;
const CURSOR = { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" };
const RELAY_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_LIST_DEFAULT_LIMIT = 50;
const INTENT_LIST_MAX_LIMIT = 100;
const CONNECTION_LIST_DEFAULT_LIMIT = 25;
const CONNECTION_LIST_MAX_LIMIT = 50;
const FIND_INTENT_PAGE_LIMIT = 100;
const FIND_INTENT_MAX_PAGES = 4;
const INTENT_STATUSES = new Set(["open", "consumed", "expired"]);
const INTENT_KINDS = new Set(["recurring", "recurring-relative", "recurring-stack", "trigger"]);
const RELAY_CONNECTION_DISCLAIMER =
  "Relay-discovered signed authorizations only. Open is not current chain status; verify the capsule at a pinned canonical block before execution.";
const PROFILE_ZAP_LIMIT = 200;
const ZAP_ACTIVITY_LIMIT = 200;
const MODEL_VALUE_MAX_DEPTH = 12;
const MODEL_VALUE_MAX_NODES = 5_000;
const MODEL_STRING_MAX_CHARS = 32_768;
const POLICY_HALT_STATUSES = new Set(["unsupported", "active", "halted", "unavailable"]);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Shared helpers

/** Recurring series are keyed by seriesId; triggers by nonce. One name for both. */
function authorizationIdOf(item) {
  return item.kind === "trigger" ? item.intent.nonce : item.intent.seriesId;
}

/**
 * Find one signed authorization, from the local store first and the relay second.
 *
 * Local wins on a tie because a file on this machine is what the owner put there deliberately,
 * while the relay is a shared pool anyone can publish into. Both are re-validated by the same
 * schema gate and both are re-verified onchain, so the ordering is about provenance, not trust.
 */
async function findIntent(ctx, zapRaw, authorizationId, { cursor: initialCursor = null } = {}) {
  const zap = getAddress(zapRaw);
  if (typeof authorizationId !== "string" || !UINT_PATTERN.test(authorizationId)) {
    throw new Error("authorizationId is malformed");
  }
  if (initialCursor !== null && (typeof initialCursor !== "string" || !RELAY_CURSOR.test(initialCursor))) {
    throw new Error("intent lookup cursor is malformed");
  }
  const wanted = BigInt(authorizationId);
  const matches = (item) => isAddressEqual(getAddress(item.intent.zap), zap) && authorizationIdOf(item) === wanted;

  let local;
  try {
    local = loadIntents(ctx.cfg.intentsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    local = { ok: [], bad: [] };
  }
  const localHit = local.ok.find(matches);
  if (localHit) {
    return {
      item: { ...localHit, source: "local" },
      incomplete: false,
      nextCursor: null,
      pagesSearched: 0,
      recordsSearched: 0,
      invalidRecords: 0,
    };
  }

  if (!ctx.cfg.relayUrl) {
    return {
      item: null,
      incomplete: false,
      nextCursor: null,
      pagesSearched: 0,
      recordsSearched: 0,
      invalidRecords: 0,
    };
  }

  let cursor = initialCursor;
  const seen = new Set(cursor ? [cursor] : []);
  let pagesSearched = 0;
  let recordsSearched = 0;
  let invalidRecords = 0;

  while (pagesSearched < FIND_INTENT_MAX_PAGES) {
    const params = new URLSearchParams({
      status: "open",
      zap,
      limit: String(FIND_INTENT_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const path = `/api/intents?${params.toString()}`;
    const response = await fetch(`${ctx.cfg.relayUrl}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${path} returned HTTP ${response.status}`);
    }
    const body = await boundedResponseJson(response, 1_048_576, `GET ${path}`);
    if (!Array.isArray(body?.intents) || body.intents.length > FIND_INTENT_PAGE_LIMIT) {
      throw new Error("relay returned an invalid intent page");
    }

    pagesSearched += 1;
    recordsSearched += body.intents.length;
    for (const record of body.intents) {
      try {
        if (typeof record?.id !== "string" || !RELAY_ID.test(record.id)) {
          throw new Error("relay row id is malformed");
        }
        const item = validateIntentObject({
          kind: record.kind,
          intent: record.intent,
          signature: record.signature,
        });
        if (matches(item)) {
          return {
            item: {
              ...item,
              file: `relay:${record.id.toLowerCase()}`,
              source: "relay",
              relayId: record.id.toLowerCase(),
            },
            incomplete: false,
            nextCursor: null,
            pagesSearched,
            recordsSearched,
            invalidRecords,
          };
        }
      } catch {
        invalidRecords += 1;
      }
    }

    const nextCursor = nextCursorOf(body, "relay intent search");
    if (nextCursor !== null) {
      if (seen.has(nextCursor)) throw new Error("relay returned a repeated intent cursor");
      seen.add(nextCursor);
    }
    cursor = nextCursor;
    if (!cursor) {
      return {
        item: null,
        incomplete: false,
        nextCursor: null,
        pagesSearched,
        recordsSearched,
        invalidRecords,
      };
    }
  }

  return {
    item: null,
    incomplete: true,
    nextCursor: cursor,
    pagesSearched,
    recordsSearched,
    invalidRecords,
  };
}

function lookupEnvelope(result) {
  return {
    found: result.item !== null,
    incomplete: result.incomplete,
    truncated: result.incomplete,
    nextCursor: result.nextCursor,
    pagesSearched: result.pagesSearched,
    recordsSearched: result.recordsSearched,
    invalidRecords: result.invalidRecords,
  };
}

function missingIntentResult(result, zap, authorizationId) {
  return {
    ...lookupEnvelope(result),
    zap: getAddress(zap),
    authorizationId: String(authorizationId),
    detail: result.incomplete
      ? `No matching signed authorization was found within this bounded search. Continue with cursor ${result.nextCursor}.`
      : "No matching signed authorization was found in the local store or the complete relay search.",
  };
}

function nextCursorOf(body, label) {
  const value = body?.nextCursor;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !RELAY_CURSOR.test(value)) {
    throw new Error(`${label} returned a malformed cursor`);
  }
  return value;
}

function paginationArgs(limitRaw, cursorRaw, defaultLimit, maxLimit, label) {
  const limit = limitRaw ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`${label} limit must be an integer from 1 to ${maxLimit}`);
  }
  if (
    cursorRaw !== undefined
    && cursorRaw !== null
    && (typeof cursorRaw !== "string" || !RELAY_CURSOR.test(cursorRaw))
  ) {
    throw new Error(`${label} cursor is malformed`);
  }
  return { limit, cursor: cursorRaw ?? null };
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
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
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function addressValue(value, label) {
  try {
    return getAddress(stringValue(value, label, 42));
  } catch {
    throw new Error(`${label} is not a 20-byte hex address`);
  }
}

function decimalValue(value, label) {
  return stringValue(value, label, 78, /^[0-9]+$/);
}

function timestampValue(value, label) {
  const timestamp = stringValue(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is not an ISO timestamp`);
  return timestamp;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a non-negative integer`);
  return value;
}

function nullableNonnegativeInteger(value, label) {
  return value === null ? null : nonnegativeInteger(value, label);
}

function projectPolicyHalt(raw, lineage, label) {
  const halt = objectValue(raw, label);
  if (!POLICY_HALT_STATUSES.has(halt.status)) throw new Error(`${label}.status is malformed`);
  if (halt.policyHalted !== null && typeof halt.policyHalted !== "boolean") {
    throw new Error(`${label}.policyHalted is malformed`);
  }
  if (
    (halt.status === "unsupported" && (!["v1.1", "v3", "v3.1"].includes(lineage) || halt.policyHalted !== null))
    || (halt.status === "active" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== false))
    || (halt.status === "halted" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== true))
    || (halt.status === "unavailable" && (!["v1.2", "v3.2"].includes(lineage) || halt.policyHalted !== null))
  ) {
    throw new Error(`${label} contradicts the canonical lineage`);
  }
  const haltedAt = nullableNonnegativeInteger(halt.haltedAt, `${label}.haltedAt`);
  const haltedTx = halt.haltedTx === null
    ? null
    : stringValue(halt.haltedTx, `${label}.haltedTx`, 66, TX_HASH);
  if (halt.status === "halted" && (haltedAt === null || haltedTx === null)) {
    throw new Error(`${label} is missing canonical halt-event provenance`);
  }
  if (
    (halt.status === "unsupported" || halt.status === "active")
    && (haltedAt !== null || haltedTx !== null)
  ) {
    throw new Error(`${label} carries halt-event provenance without a halted state`);
  }
  if (halt.status === "unavailable" && (haltedAt === null) !== (haltedTx === null)) {
    throw new Error(`${label} carries incomplete halt-event provenance`);
  }
  return { status: halt.status, policyHalted: halt.policyHalted, haltedAt, haltedTx };
}

function projectIntentSummary(record, index) {
  const row = objectValue(record, `intent list row ${index}`);
  const intent = objectValue(row.intent, `intent list row ${index}.intent`);
  if (!INTENT_KINDS.has(row.kind)) throw new Error(`intent list row ${index}.kind is malformed`);
  if (!INTENT_STATUSES.has(row.status)) throw new Error(`intent list row ${index}.status is malformed`);
  return {
    id: stringValue(row.id, `intent list row ${index}.id`, 36, RELAY_ID),
    zap: addressValue(row.zap, `intent list row ${index}.zap`),
    owner: addressValue(row.owner, `intent list row ${index}.owner`),
    kind: row.kind,
    status: row.status,
    createdAt: timestampValue(row.createdAt, `intent list row ${index}.createdAt`),
    executor: addressValue(intent.executor, `intent list row ${index}.intent.executor`),
    recipient: addressValue(intent.recipient, `intent list row ${index}.intent.recipient`),
  };
}

function assertIntentMatchesFilters(intent, requestedFilters, index) {
  if (intent.status !== requestedFilters.status) {
    throw new Error(`intent list row ${index}.status does not match the request`);
  }
  for (const key of ["owner", "zap", "executor"]) {
    const requested = requestedFilters[key];
    if (requested && !isAddressEqual(intent[key], requested)) {
      throw new Error(`intent list row ${index}.${key} does not match the request`);
    }
  }
}

function projectProfile(profileRaw, requestedOwner) {
  const profile = objectValue(profileRaw, "profile response");
  const owner = addressValue(profile.owner, "profile.owner");
  if (!isAddressEqual(owner, requestedOwner)) throw new Error("profile response owner does not match the request");
  if (profile.sourceStatus !== "live" && profile.sourceStatus !== "degraded") {
    throw new Error("profile.sourceStatus is malformed");
  }
  const stats = objectValue(profile.stats, "profile.stats");
  const executedVolume = objectValue(stats.executedVolume, "profile.stats.executedVolume");
  if (Object.keys(executedVolume).length > 32) throw new Error("profile executed-volume map is too large");
  const projectedVolume = Object.fromEntries(
    Object.entries(executedVolume).map(([symbol, amount]) => [
      stringValue(symbol, "profile executed-volume symbol", 64),
      decimalValue(amount, `profile executed volume for ${symbol}`),
    ]),
  );
  if (!Array.isArray(profile.zaps) || profile.zaps.length > PROFILE_ZAP_LIMIT) {
    throw new Error(`profile response must contain at most ${PROFILE_ZAP_LIMIT} zaps`);
  }
  return {
    owner,
    sourceStatus: profile.sourceStatus,
    stats: {
      zapsCreated: nonnegativeInteger(stats.zapsCreated, "profile.stats.zapsCreated"),
      oneShotExecutions: nonnegativeInteger(stats.oneShotExecutions, "profile.stats.oneShotExecutions"),
      automatedRuns: nonnegativeInteger(stats.automatedRuns, "profile.stats.automatedRuns"),
      recoveries: nonnegativeInteger(stats.recoveries, "profile.stats.recoveries"),
      policiesHalted: nonnegativeInteger(stats.policiesHalted, "profile.stats.policiesHalted"),
      authorizationsRevoked: nonnegativeInteger(
        stats.authorizationsRevoked,
        "profile.stats.authorizationsRevoked",
      ),
      executedVolume: projectedVolume,
    },
    zaps: profile.zaps.map((zapRaw, index) => {
      const zap = objectValue(zapRaw, `profile.zaps[${index}]`);
      if (!["v1.1", "v1.2", "v3", "v3.1", "v3.2"].includes(zap.lineage)) {
        throw new Error(`profile.zaps[${index}].lineage is malformed`);
      }
      const policyHalt = projectPolicyHalt(
        {
          status: zap.policyHaltStatus,
          policyHalted: zap.policyHalted,
          haltedAt: zap.haltedAt,
          haltedTx: zap.haltedTx,
        },
        zap.lineage,
        `profile.zaps[${index}].policyHalt`,
      );
      return {
        address: addressValue(zap.address, `profile.zaps[${index}].address`),
        lineage: zap.lineage,
        policyHaltStatus: policyHalt.status,
        policyHalted: policyHalt.policyHalted,
        haltedAt: policyHalt.haltedAt,
        haltedTx: policyHalt.haltedTx,
        executionCount: nonnegativeInteger(zap.executionCount, `profile.zaps[${index}].executionCount`),
        automatedRunCount: nonnegativeInteger(
          zap.automatedRunCount,
          `profile.zaps[${index}].automatedRunCount`,
        ),
        lastActivityAt: nullableNonnegativeInteger(
          zap.lastActivityAt,
          `profile.zaps[${index}].lastActivityAt`,
        ),
      };
    }),
  };
}

function projectConnectionPage(bodyRaw, requestedAgent, limit, nextCursor) {
  const body = objectValue(bodyRaw, "connection list response");
  const agent = addressValue(body.agent, "connection list agent");
  if (!isAddressEqual(agent, requestedAgent)) {
    throw new Error("connection list agent does not match the request");
  }
  if (!Array.isArray(body.connections) || body.connections.length > limit) {
    throw new Error("connection list returned an invalid page");
  }
  const relayTruth = relayTruthMetadata(body, "connection list response");
  let authorizationCount = 0;
  const connections = body.connections.map((connectionRaw, index) => {
    const row = objectValue(connectionRaw, `connection list row ${index}`);
    const zap = addressValue(row.zap, `connection list row ${index}.zap`);
    const owner = addressValue(row.owner, `connection list row ${index}.owner`);
    const connection = objectValue(row.connection, `connection list row ${index}.connection`);
    if (!["open", "self", "pinned"].includes(connection.state)) {
      throw new Error(`connection list row ${index}.connection.state is malformed`);
    }
    if (connection.state === "open") {
      throw new Error(
        `connection list row ${index}.connection.state cannot be open for an agent-filtered response`,
      );
    }
    const expectedState = isAddressEqual(owner, requestedAgent) ? "self" : "pinned";
    if (connection.state !== expectedState) {
      throw new Error(
        `connection list row ${index}.connection.state does not match its owner and requested agent`,
      );
    }
    const connectionAgent = addressValue(
      connection.agent,
      `connection list row ${index}.connection.agent`,
    );
    if (!isAddressEqual(connectionAgent, requestedAgent)) {
      throw new Error(`connection list row ${index}.connection.agent does not match the request`);
    }
    const projectedConnection = { state: connection.state, agent: connectionAgent };
    if (!Array.isArray(row.authorizations) || row.authorizations.length === 0) {
      throw new Error(`connection list row ${index}.authorizations must be a non-empty array`);
    }
    authorizationCount += row.authorizations.length;
    if (authorizationCount > limit) throw new Error("connection list returned too many authorizations");
    const authorizations = row.authorizations.map((authorizationRaw, authorizationIndex) => {
      const label = `connection list row ${index}.authorizations[${authorizationIndex}]`;
      const authorization = objectValue(authorizationRaw, label);
      if (!INTENT_KINDS.has(authorization.kind)) throw new Error(`${label}.kind is malformed`);
      return {
        id: stringValue(authorization.id, `${label}.id`, 36, RELAY_ID),
        kind: authorization.kind,
        publishedAt: timestampValue(authorization.publishedAt, `${label}.publishedAt`),
        authorizationId: decimalValue(authorization.authorizationId, `${label}.authorizationId`),
        recipient: addressValue(authorization.recipient, `${label}.recipient`),
        outAsset: addressValue(authorization.outAsset, `${label}.outAsset`),
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
    });
    return { zap, owner, connection: projectedConnection, authorizations };
  });
  const owners = [
    ...new Map(connections.map((connection) => [connection.owner.toLowerCase(), connection.owner])).values(),
  ];
  return {
    agent,
    ...relayTruth,
    connections,
    owners,
    nextCursor,
    incomplete: nextCursor !== null,
    readAt: timestampValue(body.readAt, "connection list readAt"),
  };
}

function relayTruthMetadata(body, label) {
  if (body.source !== "relay") throw new Error(`${label}.source must be relay`);
  if (body.chainVerified !== false) throw new Error(`${label}.chainVerified must be false`);
  if (body.statusBasis !== "relay-open-row") {
    throw new Error(`${label}.statusBasis must be relay-open-row`);
  }
  if (body.stalePossible !== true) throw new Error(`${label}.stalePossible must be true`);
  if (body.disclaimer !== RELAY_CONNECTION_DISCLAIMER) {
    throw new Error(`${label}.disclaimer is malformed`);
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
  if (state.nodes > MODEL_VALUE_MAX_NODES) throw new Error(`${label} contains too many values`);
  if (depth > MODEL_VALUE_MAX_DEPTH) throw new Error(`${label} is nested too deeply`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MODEL_STRING_MAX_CHARS) throw new Error(`${label} contains an oversized string`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > ZAP_ACTIVITY_LIMIT) throw new Error(`${label} contains too many rows`);
    return value.map((entry, index) => boundedModelValue(entry, `${label}[${index}]`, state, depth + 1));
  }
  const object = objectValue(value, label);
  const entries = Object.entries(object);
  if (entries.length > 200) throw new Error(`${label} contains too many fields`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      stringValue(key, `${label} field name`, 128),
      boundedModelValue(entry, `${label}.${key}`, state, depth + 1),
    ]),
  );
}

function projectZapDetail(detailRaw) {
  const detail = objectValue(detailRaw, "zap response");
  if (!["v1.1", "v1.2", "v3", "v3.1", "v3.2"].includes(detail.lineage)) {
    throw new Error("zap response lineage is malformed");
  }
  if (!["created", "funded", "executed", "recovered"].includes(detail.lifecycle)) {
    throw new Error("zap response lifecycle is malformed");
  }
  if (!Array.isArray(detail.executions) || detail.executions.length > ZAP_ACTIVITY_LIMIT) {
    throw new Error(`zap response must contain at most ${ZAP_ACTIVITY_LIMIT} executions`);
  }
  if (!Array.isArray(detail.recoveries) || detail.recoveries.length > ZAP_ACTIVITY_LIMIT) {
    throw new Error(`zap response must contain at most ${ZAP_ACTIVITY_LIMIT} recoveries`);
  }
  return {
    lineage: detail.lineage,
    provenance: boundedModelValue(objectValue(detail.provenance, "zap.provenance"), "zap.provenance"),
    policy: boundedModelValue(objectValue(detail.policy, "zap.policy"), "zap.policy"),
    policyHalt: projectPolicyHalt(detail.policyHalt, detail.lineage, "zap.policyHalt"),
    stats: boundedModelValue(objectValue(detail.stats, "zap.stats"), "zap.stats"),
    balances: boundedModelValue(objectValue(detail.balances, "zap.balances"), "zap.balances"),
    executions: boundedModelValue(detail.executions, "zap.executions"),
    recoveries: boundedModelValue(detail.recoveries, "zap.recoveries"),
    lifecycle: detail.lifecycle,
    headBlock: decimalValue(detail.headBlock, "zap.headBlock"),
    readAt: timestampValue(detail.readAt, "zap.readAt"),
    factory: boundedModelValue(objectValue(detail.factory, "zap.factory"), "zap.factory"),
  };
}

function describeIntent(item) {
  const { intent, kind } = item;
  const executor = getAddress(intent.executor);
  return {
    kind,
    source: item.source ?? "local",
    zap: getAddress(intent.zap),
    authorizationId: authorizationIdOf(item).toString(),
    validAfter: intent.validAfter.toString(),
    deadline: intent.deadline.toString(),
    recipient: getAddress(intent.recipient),
    outAsset: getAddress(intent.outAsset),
    executor: isAddressEqual(executor, zeroAddress) ? null : executor,
    executorAccess: isAddressEqual(executor, zeroAddress) ? "anyone" : "pinned",
    interval: intent.interval?.toString() ?? null,
    maxRuns: intent.maxRuns?.toString() ?? null,
    maxGas: intent.maxGas.toString(),
    maxFeePerGas: intent.maxFeePerGas.toString(),
    policyHash: intent.policyHash,
  };
}

/**
 * Every custom error the capsule can revert with, in plain language.
 *
 * Static on purpose: these are the contract's own error selectors, and an agent that guesses at
 * what a revert meant will confidently tell a human the wrong thing. Sourced from
 * contracts/src/v3/OpenZapV3.sol:138-173.
 */
const ERRORS = {
  ExecutorMismatch:
    "This authorization pins a specific executor and you are not it. Only the pinned address may submit; the owner must sign new terms to change that.",
  IntervalNotElapsed: "The cadence has not elapsed. The capsule refuses early runs — wait for the next interval.",
  NonceReplay: "This authorization id is already spent. Each run consumes one id; it can never be reused.",
  TriggerNotMet: "The signed price condition is not met right now. The capsule re-reads the price itself at execution.",
  MinOutNotMet:
    "Output would be below the signed floor, net of the 1% execution fee. Not an error to retry blindly — the route is currently worse than the owner agreed to accept.",
  Expired: "The signed deadline has passed. Nothing can revive this authorization; the owner must sign new terms.",
  NotYetValid: "The signed validAfter time has not arrived yet.",
  GasLimitTooHigh:
    "The transaction gas limit exceeds the signed maxGas. Simulate with gas capped at intent.maxGas, not at the block limit.",
  GasPriceTooHigh: "The transaction gas price exceeds the signed maxFeePerGas. Wait for the base fee to fall.",
  BadSignature: "The signature does not recover to the capsule owner (EOA or ERC-1271).",
  PolicyMismatch: "The submitted policy does not hash to the capsule's frozen policy. The capsule is immutable; the caller is wrong.",
  WrongRecipient: "The recipient does not match the capsule's welded recipient. It was set at initialize and has no setter.",
  WrongChain: "The intent was signed for a different chain id.",
  WrongZap: "The intent was signed for a different capsule.",
  FeeAboveCap: "The relayer fee exceeds the policy's maxRelayerFeeCap.",
  NotOwner: "Only the capsule owner may call this. Revocation and emergency exit are owner-only, by design.",
  AdapterNotAllowed: "The step's adapter is not on the allowlist.",
  TokenNotAllowed: "The step's token is not on the allowlist.",
  InvalidSchedule: "The recurring interval or run count is outside what the capsule accepts.",
  InvalidThreshold: "The trigger threshold is outside the accepted range (1..10000 bps).",
  PriceSourceNotAllowed: "The trigger's price source is not on the allowlist.",
  Reentrancy: "Reentrancy guard tripped.",
};

// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "agent_identity",
    safety: READ_ONLY,
    description:
      "Report this agent's explicitly configured public address — the address a human may pin in a signed intent. This MCP server never reads or derives it from an executor key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      if (!ctx.executorAddress) {
        return {
          mode: "read-only",
          executorAddress: null,
          detail:
            "No OPENZAPS_AGENT_ADDRESS is configured, so this discovery server has no public address to propose. It can still read capsules, explain policies, and simulate.",
        };
      }
      return {
        mode: "public-address",
        executorAddress: ctx.executorAddress,
        chainId: ctx.cfg.chainId,
        detail:
          "This is a public identifier, not proof that an executor key exists. If the owner pins it, only that address may submit; pinning remains a liveness trade.",
        howToPin: `${ctx.appUrl}/zap?view=connect&agent=${ctx.executorAddress}`,
      };
    },
  },

  {
    name: "list_zaps",
    safety: READ_ONLY,
    description: "List the capsules a wallet created, with confirmed run counts and lifecycle state.",
    inputSchema: {
      type: "object",
      properties: { owner: ADDRESS },
      required: ["owner"],
      additionalProperties: false,
    },
    async handler({ owner }, ctx) {
      const requestedOwner = getAddress(owner);
      const profile = await appGet(ctx, `/api/profile/${requestedOwner}`);
      return projectProfile(profile, requestedOwner);
    },
  },

  {
    name: "read_zap",
    safety: READ_ONLY,
    description:
      "Read one capsule: its frozen policy, balances, confirmed executions, and every invariant that does NOT hold.",
    inputSchema: {
      type: "object",
      properties: { address: ADDRESS },
      required: ["address"],
      additionalProperties: false,
    },
    async handler({ address }, ctx) {
      return projectZapDetail(await appGet(ctx, `/api/zaps/${getAddress(address)}`));
    },
  },

  {
    name: "explain_policy",
    safety: READ_ONLY,
    description:
      "Explain in plain language what one capsule can and cannot do, including whether its committed policy hash still verifies.",
    inputSchema: {
      type: "object",
      properties: { address: ADDRESS },
      required: ["address"],
      additionalProperties: false,
    },
    async handler({ address }, ctx) {
      const detail = projectZapDetail(await appGet(ctx, `/api/zaps/${getAddress(address)}`));
      const policy = detail.policy;
      return {
        address: getAddress(address),
        lifecycle: detail.lifecycle,
        canDo: [
          policy.routeKind ? `Run a ${policy.routeKind} route${policy.inputSymbol ? ` from ${policy.inputSymbol}` : ""}${policy.outputSymbol ? ` to ${policy.outputSymbol}` : ""}.` : "Run its frozen step sequence.",
          `Pay out only to ${policy.recipient}.`,
        ],
        cannotDo: [
          "Change its recipient — set once at initialize, no setter exists.",
          "Change its steps, adapters, or calldata — the policy is hashed at initialize and re-checked on every run.",
          "Pay a relayer more than its maxRelayerFeeCap.",
        ],
        integrity: {
          policyHash: policy.policyHash,
          hashMatches: policy.hashMatches,
          canonicalClone: policy.canonicalClone,
          matchesLiveRoute: policy.matchesLiveRoute,
          // The one field worth reading before anything else. A non-empty list
          // means an invariant this capsule claims does not actually hold.
          deviations: policy.deviations,
        },
        verdict:
          policy.deviations.length === 0
            ? "Every checked invariant holds."
            : `${policy.deviations.length} invariant(s) do NOT hold — read the deviations list before acting on this capsule.`,
      };
    },
  },

  {
    name: "list_intents",
    safety: READ_ONLY,
    description:
      "List signed standing authorizations from the shared relay. Filter by owner, capsule, executor, or status.",
    inputSchema: {
      type: "object",
      properties: {
        owner: ADDRESS,
        zap: ADDRESS,
        executor: ADDRESS,
        status: { type: "string", enum: ["open", "consumed", "expired"] },
        limit: { type: "integer", minimum: 1, maximum: INTENT_LIST_MAX_LIMIT },
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const status = args.status ?? "open";
      if (!INTENT_STATUSES.has(status)) throw new Error("intent list status is malformed");
      const { limit, cursor } = paginationArgs(
        args.limit,
        args.cursor,
        INTENT_LIST_DEFAULT_LIMIT,
        INTENT_LIST_MAX_LIMIT,
        "intent list",
      );
      const params = new URLSearchParams();
      const requestedFilters = { status };
      for (const key of ["owner", "zap", "executor"]) {
        if (args[key] !== undefined) {
          const address = getAddress(args[key]);
          params.set(key, address);
          requestedFilters[key] = address;
        }
      }
      params.set("status", status);
      params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const body = await appGet(ctx, `/api/intents?${params.toString()}`);
      if (!Array.isArray(body?.intents) || body.intents.length > limit) {
        throw new Error("intent list returned an invalid page");
      }
      const nextCursor = nextCursorOf(body, "intent list");
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
    name: "read_intent",
    safety: READ_ONLY,
    description:
      "Read the full signed terms of one standing authorization, from the local store or the relay.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT, cursor: CURSOR },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId, cursor }, ctx) {
      const result = await findIntent(ctx, zap, authorizationId, { cursor });
      if (!result.item) return missingIntentResult(result, zap, authorizationId);
      return {
        ...lookupEnvelope(result),
        ...describeIntent(result.item),
      };
    },
  },

  {
    name: "check_intent_status",
    safety: READ_ONLY,
    description:
      "Ask the chain whether one authorization is due, waiting, finished, or expired right now. Reads the same state the capsule enforces.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT, cursor: CURSOR },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId, cursor }, ctx) {
      const result = await findIntent(ctx, zap, authorizationId, { cursor });
      if (!result.item) return missingIntentResult(result, zap, authorizationId);
      const item = result.item;
      const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
      const evaluate = item.kind === "trigger" ? evaluateTrigger : evaluateRecurring;
      const verdict = await evaluate(ctx.publicClient, item, block.timestamp);
      return {
        ...lookupEnvelope(result),
        zap: getAddress(zap),
        authorizationId: String(authorizationId),
        kind: item.kind,
        status: verdict.status,
        detail: verdict.detail,
        readAtBlock: block.number.toString(),
        readAtTimestamp: block.timestamp.toString(),
      };
    },
  },

  {
    name: "simulate_run",
    safety: READ_ONLY,
    description:
      "Ask the capsule whether it would accept a run of this authorization right now, and if not, which guard refuses. Never sends a transaction.",
    inputSchema: {
      type: "object",
      properties: { zap: ADDRESS, authorizationId: UINT, cursor: CURSOR },
      required: ["zap", "authorizationId"],
      additionalProperties: false,
    },
    async handler({ zap, authorizationId, cursor }, ctx) {
      const lookup = await findIntent(ctx, zap, authorizationId, { cursor });
      if (!lookup.item) return missingIntentResult(lookup, zap, authorizationId);
      const item = lookup.item;
      // The null walletClient IS the guarantee. submitExecution returns
      // { outcome: "watch-only" } on a passing simulation and cannot reach its
      // broadcast branch without a signer — so this is unable to send a
      // transaction, not merely instructed not to.
      const submission = await submitExecution(ctx.publicClient, null, item, ctx.cfg);
      return {
        ...lookupEnvelope(lookup),
        zap: getAddress(zap),
        authorizationId: String(authorizationId),
        outcome: submission.outcome,
        detail: submission.detail,
        wouldExecute: submission.outcome === "watch-only",
        refusedBy: refusedByForSubmission(submission),
      };
    },
  },

  {
    name: "list_connections",
    safety: READ_ONLY,
    description:
      "List relay-discovered capsules whose relay rows name an agent address. Rows may be stale and are not proof of chain-current authority.",
    inputSchema: {
      type: "object",
      properties: {
        agent: ADDRESS,
        limit: { type: "integer", minimum: 1, maximum: CONNECTION_LIST_MAX_LIMIT },
        cursor: CURSOR,
      },
      required: ["agent"],
      additionalProperties: false,
    },
    async handler({ agent, limit, cursor }, ctx) {
      const page = paginationArgs(
        limit,
        cursor,
        CONNECTION_LIST_DEFAULT_LIMIT,
        CONNECTION_LIST_MAX_LIMIT,
        "connection list",
      );
      const params = new URLSearchParams({ limit: String(page.limit) });
      if (page.cursor) params.set("cursor", page.cursor);
      const requestedAgent = getAddress(agent);
      const body = await appGet(ctx, `/api/agents/${requestedAgent}?${params.toString()}`);
      const nextCursor = nextCursorOf(body, "connection list");
      return projectConnectionPage(body, requestedAgent, page.limit, nextCursor);
    },
  },

  {
    name: "draft_intent",
    safety: READ_ONLY,
    description:
      "Draft an UNSIGNED standing authorization and return the link a human opens to review and sign it. This cannot sign — only the capsule owner's wallet can.",
    inputSchema: {
      type: "object",
      required: ["zap", "mode"],
      additionalProperties: false,
      properties: {
        zap: ADDRESS,
        mode: { type: "string", enum: ["recurring", "trigger"] },
        executor: ADDRESS,
        interval: { type: "string", enum: ["hourly", "6h", "daily", "weekly", "monthly"] },
        runs: { type: "string", pattern: "^[0-9]{1,3}$" },
        threshold: { type: "string", enum: ["up5", "up10", "up25", "down5", "down10", "down25"] },
      },
    },
    async handler(args, ctx) {
      const zap = getAddress(args.zap);
      const executor = args.executor ? getAddress(args.executor) : ctx.executorAddress;
      const params = new URLSearchParams({
        view: "automate",
        src: "build",
        mode: args.mode,
        route: "robinhood-v4-weth-zaps",
        amount: "0.01",
        bps: "100",
      });
      if (args.mode === "trigger") {
        params.set("threshold", args.threshold ?? "up10");
        params.set("days", "30");
      } else {
        params.set("interval", args.interval ?? "daily");
        params.set("runs", args.runs ?? "10");
      }
      if (executor) params.set("agent", executor);

      return {
        signed: false,
        zap,
        proposedExecutor: executor,
        // The ONLY way this becomes real. There is no code path in this server
        // that produces a signature.
        signHere: `${ctx.appUrl}/zap?${params.toString()}`,
        detail:
          "Give this link to the capsule owner. They review the terms and sign in their own wallet; nothing is authorized until they do.",
      };
    },
  },

  {
    name: "publish_intent",
    safety: PUBLISH,
    description:
      "Publish an ALREADY-SIGNED standing authorization to the shared relay so executors can discover it. Rejects anything unsigned; the relay re-verifies the signature against the capsule's onchain owner regardless.",
    inputSchema: {
      type: "object",
      required: ["signedIntent"],
      additionalProperties: false,
      properties: {
        signedIntent: {
          type: "object",
          required: ["kind", "intent", "signature"],
          properties: {
            kind: {
              type: "string",
              enum: ["recurring", "recurring-relative", "recurring-stack", "trigger"],
            },
            intent: { type: "object" },
            signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130,}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async handler({ signedIntent }, ctx) {
      // Same schema gate the daemon applies to a dropped file. It also enforces
      // the signature's presence and shape, so an unsigned draft cannot pass.
      const validated = validateIntentObject(signedIntent);
      if (BigInt(validated.intent.chainId) !== BigInt(ctx.cfg.chainId)) {
        throw new Error(`intent is for chain ${validated.intent.chainId}, this agent is on ${ctx.cfg.chainId}`);
      }

      const response = await fetch(`${ctx.appUrl}/api/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signedIntent),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await boundedResponseJson(response, 65_536, "relay publish response");
      if (!response.ok) {
        const detail =
          typeof body?.error === "string" && body.error.length <= 1_024 ? ` — ${body.error}` : "";
        throw new Error(`relay refused the intent (HTTP ${response.status})${detail}`);
      }
      return {
        published: "relay",
        id: stringValue(body?.id, "relay publish id", 36, RELAY_ID),
        detail: "Executors can now discover this authorization.",
      };
    },
  },

  {
    name: "deliver_intent_local",
    safety: PUBLISH,
    description:
      "Hand an ALREADY-SIGNED authorization to the executor running on this machine. Reads the local intake token off disk; the token is never returned and never enters your context.",
    inputSchema: {
      type: "object",
      required: ["signedIntent"],
      additionalProperties: false,
      properties: {
        signedIntent: {
          type: "object",
          required: ["kind", "intent", "signature"],
          properties: {
            kind: {
              type: "string",
              enum: ["recurring", "recurring-relative", "recurring-stack", "trigger"],
            },
            intent: { type: "object" },
            signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130,}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async handler({ signedIntent }, ctx) {
      const validated = validateIntentObject(signedIntent);
      if (BigInt(validated.intent.chainId) !== BigInt(ctx.cfg.chainId)) {
        throw new Error(`intent is for chain ${validated.intent.chainId}, this executor is on ${ctx.cfg.chainId}`);
      }

      // Read in this process, off a chmod-600 file. This replaced a browser flow
      // that had the user paste a local capability into a public https origin,
      // where it lived in sessionStorage; that flow is gone (ADR-0006 §3).
      let token;
      try {
        token = readFileSync(ctx.cfg.intakeTokenFile, "utf8").trim();
      } catch {
        throw new Error(
          `no intake token at ${ctx.cfg.intakeTokenFile} — start the executor once to mint one (node executor/index.mjs status)`,
        );
      }

      const response = await fetch(`http://127.0.0.1:${ctx.cfg.intakePort}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(signedIntent),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`the local executor refused the intent (HTTP ${response.status})`);
      }
      const body = await boundedResponseJson(response, 65_536, "local executor response");
      return {
        delivered: "local-executor",
        stored: stringValue(body?.stored, "local executor stored filename", 256),
      };
    },
  },

  {
    name: "explain_error",
    safety: READ_ONLY,
    description:
      "Explain a capsule revert in plain language, including whether it is worth retrying. Use this instead of guessing what a revert meant.",
    inputSchema: {
      type: "object",
      properties: { error: { type: "string", maxLength: 2048 } },
      required: ["error"],
      additionalProperties: false,
    },
    async handler({ error }) {
      const name = namedError(error);
      if (!name) {
        return {
          recognized: false,
          detail:
            "No OpenZap custom error found in that message. It may be an RPC or client error rather than a capsule refusal.",
        };
      }
      return { recognized: true, error: name, meaning: ERRORS[name] };
    },
  },
];

/** Pull a known capsule error name out of a revert message. */
function namedError(message) {
  if (typeof message !== "string") return null;
  for (const name of Object.keys(ERRORS)) {
    if (message.includes(name)) return name;
  }
  return null;
}

function refusedByForSubmission(result) {
  return result?.outcome === "blocked" || result?.outcome === "underfunded"
    ? namedError(result.detail)
    : null;
}

/** Sanity net: a broadcast-capable tool must never be added without a class for it. */
export function assertNoBroadcastTools(tools = TOOLS) {
  const bad = tools.filter((tool) => tool.safety !== READ_ONLY && tool.safety !== PUBLISH);
  if (bad.length > 0) {
    throw new Error(`Tools with an unknown safety class: ${bad.map((tool) => tool.name).join(", ")}`);
  }
}

export { ERRORS, authorizationIdOf, findIntent, namedError, refusedByForSubmission };
