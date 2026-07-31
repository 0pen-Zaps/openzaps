import { keccak256 } from "viem";
import {
  redactExecutorText,
  registerExecutorSensitiveValues,
} from "./redaction.mjs";

const RAW_TRANSACTION = /^0x(?:[0-9a-fA-F]{2})+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_CLASSIFICATION = "private-relay";
const KNOWN_CLASSIFICATIONS = new Set([
  PRIVATE_CLASSIFICATION,
  "direct-sequencer",
  "public-rpc",
]);
const ALREADY_KNOWN = /already known|known transaction|already imported/i;
const MAX_OUTCOMES = 256;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TRANSACTION_PAYLOAD_METHODS = new Set([
  "eth_call",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_fillTransaction",
  "eth_sendTransaction",
  "wallet_sendTransaction",
]);

export class PrivateSubmissionUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivateSubmissionUnavailableError";
  }
}

export class PrivateSubmissionRejectedError extends Error {
  constructor(message, outcome) {
    super(message);
    this.name = "PrivateSubmissionRejectedError";
    this.outcome = outcome;
  }
}

function shortText(value) {
  return redactExecutorText(value, { fallback: "", maximum: 1_000 })
    .replace(/0x[0-9a-fA-F]{64,}/g, "[hex]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function endpointOrigin(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("private relay URLs must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("private relay credentials must not be embedded in the URL");
  }
  return parsed.origin;
}

function normalizeEndpoint(endpoint, index) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    return { valid: false, reason: `endpoint ${index + 1} must be an object` };
  }
  const id = typeof endpoint.id === "string" ? endpoint.id.trim() : "";
  const url = typeof endpoint.url === "string" ? endpoint.url.trim() : "";
  const classification =
    typeof endpoint.classification === "string" ? endpoint.classification.trim() : "";
  const operator = typeof endpoint.operator === "string" ? endpoint.operator.trim() : "";
  const authorization =
    typeof endpoint.authorization === "string" ? endpoint.authorization.trim() : "";
  if (!id || id.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    return { valid: false, reason: `endpoint ${index + 1} has an invalid id` };
  }
  if (!KNOWN_CLASSIFICATIONS.has(classification)) {
    return {
      valid: false,
      id,
      reason:
        `endpoint ${index + 1} classification must be private-relay, direct-sequencer, or public-rpc`,
    };
  }
  if (!operator || operator.length > 96) {
    return {
      valid: false,
      id,
      reason: `endpoint ${index + 1} must declare its relay operator`,
    };
  }
  let origin;
  try {
    origin = endpointOrigin(url);
  } catch (error) {
    return {
      valid: false,
      id,
      reason: `endpoint ${index + 1}: ${error.message}`,
    };
  }
  const normalized = {
    valid: true,
    id,
    origin,
    operator,
    classification,
  };
  Object.defineProperty(normalized, "url", {
    value: url,
    enumerable: false,
  });
  Object.defineProperty(normalized, "authorization", {
    value: authorization,
    enumerable: false,
  });
  return normalized;
}

/**
 * Validate the operator-declared relay set without treating a public RPC or Robinhood's direct
 * sequencer endpoint as private. URL origins and operators must both be distinct: two aliases run
 * by one provider do not become two censorship domains merely because they have different names.
 */
export function assessPrivateRelaySet(endpoints, minimumDistinctOrigins = 2) {
  const configuredEndpoints = Array.isArray(endpoints) ? endpoints : [];
  registerExecutorSensitiveValues({
    urls: configuredEndpoints.map((endpoint) => endpoint?.url),
    credentials: configuredEndpoints.map((endpoint) => endpoint?.authorization),
    labels: configuredEndpoints.flatMap((endpoint) => [
      endpoint?.origin,
      endpoint?.operator,
    ]),
  });
  const minimum =
    Number.isInteger(minimumDistinctOrigins) && minimumDistinctOrigins >= 2
      ? minimumDistinctOrigins
      : 2;
  const normalized = configuredEndpoints.map(normalizeEndpoint);
  const configurationErrors = normalized
    .filter((endpoint) => !endpoint.valid)
    .map((endpoint) => endpoint.reason);
  const declaredPrivate = normalized.filter(
    (endpoint) => endpoint.valid && endpoint.classification === PRIVATE_CLASSIFICATION,
  );
  const origins = new Set();
  const operators = new Set();
  const ids = new Set();
  const eligible = [];
  for (const endpoint of declaredPrivate) {
    if (ids.has(endpoint.id)) {
      configurationErrors.push("private relay ids must be unique");
      continue;
    }
    ids.add(endpoint.id);
    if (origins.has(endpoint.origin)) {
      configurationErrors.push("private relay URL origins must be distinct");
      continue;
    }
    if (operators.has(endpoint.operator.toLowerCase())) {
      configurationErrors.push("private relay operators must be distinct");
      continue;
    }
    origins.add(endpoint.origin);
    operators.add(endpoint.operator.toLowerCase());
    eligible.push(endpoint);
  }

  const excluded = normalized
    .filter((endpoint) => endpoint.valid && endpoint.classification !== PRIVATE_CLASSIFICATION)
    .map(({ id, classification }) => ({
      id,
      classification,
    }));
  const ready =
    configurationErrors.length === 0
    && origins.size >= minimum
    && operators.size >= minimum;
  const detail = ready
    ? `${origins.size} distinct private relay origins across ${operators.size} declared operators`
    : configurationErrors[0]
      ?? `need ${minimum} distinct private relay origins/operators; configured ${origins.size}/${operators.size}`;

  const result = {
    ready,
    detail,
    minimumDistinctOrigins: minimum,
    distinctOrigins: origins.size,
    distinctOperators: operators.size,
    excluded,
    configurationErrors,
  };
  // Eligible definitions carry authenticated URLs. Keep them available to the transport without
  // allowing readiness serialization, structured logs, or health responses to expose endpoints.
  Object.defineProperty(result, "eligible", {
    value: eligible,
    enumerable: false,
  });
  return result;
}

async function readBoundedResponse(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("relay response exceeded 64 KiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("relay response exceeded 64 KiB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function endpointResult(endpoint, status, latencyMs, detail, extra = {}) {
  return {
    id: endpoint.id,
    classification: endpoint.classification,
    status,
    latencyMs,
    detail: shortText(detail),
    ...extra,
  };
}

function deterministicHttpRejection(status) {
  return status >= 400 && status < 500;
}

function boundedRpcCode(value) {
  return Number.isSafeInteger(value) ? { rpcCode: value } : {};
}

async function dispatch(endpoint, serializedTransaction, expectedHash, timeoutMs, fetchImpl) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = (status, detail, extra = {}) =>
    endpointResult(
      endpoint,
      status,
      Date.now() - startedAt,
      shortText(detail),
      extra,
    );
  try {
    let response;
    try {
      response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.authorization ? { authorization: endpoint.authorization } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransaction",
          params: [serializedTransaction],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return result(
        "unknown",
        error?.name === "AbortError"
          ? "request timed out after dispatch"
          : "relay request failed after dispatch",
      );
    }

    let text;
    try {
      text = await readBoundedResponse(response);
    } catch {
      return result(
        deterministicHttpRejection(response.status) ? "rejected" : "unknown",
        "relay response body failed after dispatch",
        { httpStatus: response.status },
      );
    }
    if (!response.ok) {
      return result(
        deterministicHttpRejection(response.status) ? "rejected" : "unknown",
        `relay returned HTTP ${response.status} after dispatch`,
        { httpStatus: response.status },
      );
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return result(
        "unknown",
        "relay returned malformed JSON after dispatch",
        { httpStatus: response.status },
      );
    }
    if (
      typeof body?.result === "string"
      && HASH.test(body.result)
      && body.result.toLowerCase() === expectedHash.toLowerCase()
    ) {
      return result(
        "accepted",
        "relay accepted the raw transaction",
        { httpStatus: response.status },
      );
    }
    const rpcMessage = String(body?.error?.message ?? "");
    if (rpcMessage && ALREADY_KNOWN.test(rpcMessage)) {
      return result(
        "already-known",
        "relay reported the transaction as already known",
        { httpStatus: response.status, ...boundedRpcCode(body?.error?.code) },
      );
    }
    if (body?.error) {
      return result(
        "rejected",
        "relay rejected the raw transaction",
        { httpStatus: response.status, ...boundedRpcCode(body.error.code) },
      );
    }
    return result(
      "unknown",
      "relay response did not contain the expected transaction hash",
      { httpStatus: response.status },
    );
  } finally {
    clearTimeout(timer);
  }
}

function summarizeOutcome(hash, readiness, endpointOutcomes) {
  const accepted = endpointOutcomes.filter(
    (endpoint) => endpoint.status === "accepted" || endpoint.status === "already-known",
  );
  const unknown = endpointOutcomes.filter((endpoint) => endpoint.status === "unknown");
  const rejected = endpointOutcomes.filter((endpoint) => endpoint.status === "rejected");
  const status =
    accepted.length >= readiness.minimumDistinctOrigins
      ? "accepted-quorum"
      : accepted.length > 0
        ? "accepted-degraded"
        : unknown.length > 0
          ? "submission-uncertain"
          : "rejected";
  return {
    hash,
    mode: "private-multi-relay",
    status,
    requiredDistinctOrigins: readiness.minimumDistinctOrigins,
    attemptedOrigins: endpointOutcomes.length,
    acceptedOrigins: accepted.length,
    unknownOrigins: unknown.length,
    rejectedOrigins: rejected.length,
    endpoints: endpointOutcomes,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Build a JSON-RPC provider for viem's `custom(...)` transport.
 *
 * Read/preparation calls delegate to the normal public client. Locally signed raw transactions
 * are fanned out only to the eligible private relay set. `eth_sendTransaction` is refused so a
 * future JSON-RPC account cannot accidentally bypass local signing. A timeout is treated as
 * uncertain (the relay may have accepted before the connection failed), so the deterministic hash
 * is returned and the executor persists/monitors it instead of risking nonce reuse.
 */
export function createPrivateSubmissionProvider({
  endpoints,
  minimumDistinctOrigins = 2,
  timeoutMs = 8_000,
  publicRequest,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof publicRequest !== "function") {
    throw new TypeError("publicRequest must be a function");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch implementation is unavailable");
  }
  const readiness = assessPrivateRelaySet(endpoints, minimumDistinctOrigins);
  const outcomes = new Map();
  let preparationHook = null;

  function remember(outcome) {
    outcomes.set(outcome.hash.toLowerCase(), outcome);
    while (outcomes.size > MAX_OUTCOMES) {
      const oldest = outcomes.keys().next().value;
      if (oldest === undefined) break;
      outcomes.delete(oldest);
    }
  }

  return {
    readiness,
    async withPreparationHook(hook, operation) {
      if (typeof hook !== "function" || typeof operation !== "function") {
        throw new TypeError("private preparation hook and operation must be functions");
      }
      if (preparationHook) {
        throw new PrivateSubmissionUnavailableError(
          "another private raw transaction is already being prepared",
        );
      }
      preparationHook = hook;
      try {
        return await operation();
      } finally {
        preparationHook = null;
      }
    },
    getOutcome(hash) {
      return typeof hash === "string" ? outcomes.get(hash.toLowerCase()) ?? null : null;
    },
    async request({ method, params }) {
      if (TRANSACTION_PAYLOAD_METHODS.has(method)) {
        throw new PrivateSubmissionUnavailableError(
          `${method} is disabled on the wallet transport: transaction payloads must not reach the public read RPC`,
        );
      }
      if (method !== "eth_sendRawTransaction") {
        return publicRequest({ method, params });
      }
      if (!readiness.ready) {
        throw new PrivateSubmissionUnavailableError(
          `price-sensitive submission is fail-closed: ${readiness.detail}`,
        );
      }
      const serializedTransaction = params?.[0];
      if (typeof serializedTransaction !== "string" || !RAW_TRANSACTION.test(serializedTransaction)) {
        throw new PrivateSubmissionRejectedError("eth_sendRawTransaction requires canonical hex bytes");
      }
      const hash = keccak256(serializedTransaction);
      if (preparationHook) {
        // Persist the deterministic hash + signed bytes before the first network dispatch. A crash
        // can then rebroadcast the exact same nonce instead of guessing whether a relay accepted.
        await preparationHook({ hash, serializedTransaction });
      }
      const endpointOutcomes = await Promise.all(
        readiness.eligible.map((endpoint) =>
          dispatch(endpoint, serializedTransaction, hash, timeoutMs, fetchImpl),
        ),
      );
      const outcome = summarizeOutcome(hash, readiness, endpointOutcomes);
      remember(outcome);
      if (outcome.status === "rejected") {
        throw new PrivateSubmissionRejectedError(
          "every configured private relay rejected the raw transaction",
          outcome,
        );
      }
      return hash;
    },
  };
}

export function privateSubmissionDetail(outcome) {
  if (!outcome) return "";
  return (
    `private relays ${outcome.status}: ${outcome.acceptedOrigins}/${outcome.attemptedOrigins} accepted, `
    + `${outcome.unknownOrigins} unknown, ${outcome.rejectedOrigins} rejected`
  );
}
