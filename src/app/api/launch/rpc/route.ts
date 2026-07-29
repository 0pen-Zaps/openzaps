import { getRpcUrl } from "@/lib/zappad/server-config";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_LOG_RANGE = 5_000n;
const MAX_CALLDATA_BYTES = 24_576;
const MAX_CALL_GAS = 30_000_000n;
const MAX_FEE_HISTORY_BLOCKS = 128n;
const MAX_REWARD_PERCENTILES = 20;
const MAX_LOG_ADDRESSES = 10;
const MAX_TOPIC_OPTIONS = 10;

const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
};

function response(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "application/json; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, status = 400) {
  return response({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function isValidRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<JsonRpcRequest>;
  return (
    request.jsonrpc === "2.0" &&
    typeof request.method === "string" &&
    (request.id === null ||
      (typeof request.id === "string" && request.id.length <= 128) ||
      (typeof request.id === "number" && Number.isSafeInteger(request.id))) &&
    (request.params === undefined || Array.isArray(request.params))
  );
}

function isQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
}

function isData(value: unknown, maxBytes = MAX_CALLDATA_BYTES): value is string {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-f]{2})*$/i.test(value) &&
    (value.length - 2) / 2 <= maxBytes
  );
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function isBlockTag(value: unknown): value is string {
  return (
    isQuantity(value) ||
    ["earliest", "safe", "finalized", "latest", "pending"].includes(
      String(value),
    )
  );
}

function isAccessList(value: unknown) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      isAddress(record.address) &&
      Array.isArray(record.storageKeys) &&
      record.storageKeys.length <= 64 &&
      record.storageKeys.every(isHash)
    );
  });
}

function validCallParams(params: unknown[] | undefined) {
  if (!params || params.length < 1 || params.length > 2) return false;
  const transaction = params[0];
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return false;
  }
  const record = transaction as Record<string, unknown>;
  const allowedKeys = new Set([
    "accessList",
    "chainId",
    "data",
    "from",
    "gas",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "to",
    "type",
    "value",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  if (!isAddress(record.to)) return false;
  if (record.from !== undefined && !isAddress(record.from)) return false;
  if (record.data !== undefined && !isData(record.data)) return false;
  if (
    record.gas !== undefined &&
    (!isQuantity(record.gas) || BigInt(record.gas) > MAX_CALL_GAS)
  ) {
    return false;
  }
  for (const key of [
    "chainId",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "type",
    "value",
  ]) {
    if (record[key] !== undefined && !isQuantity(record[key])) return false;
  }
  if (!isAccessList(record.accessList)) return false;
  return params[1] === undefined || isBlockTag(params[1]);
}

function validFeeHistoryParams(params: unknown[] | undefined) {
  if (!params || params.length < 2 || params.length > 3) return false;
  if (
    !isQuantity(params[0]) ||
    BigInt(params[0]) < 1n ||
    BigInt(params[0]) > MAX_FEE_HISTORY_BLOCKS ||
    !isBlockTag(params[1])
  ) {
    return false;
  }
  if (params[2] === undefined) return true;
  if (!Array.isArray(params[2]) || params[2].length > MAX_REWARD_PERCENTILES) {
    return false;
  }
  let previous = -1;
  for (const percentile of params[2]) {
    if (
      typeof percentile !== "number" ||
      !Number.isFinite(percentile) ||
      percentile < 0 ||
      percentile > 100 ||
      percentile < previous
    ) {
      return false;
    }
    previous = percentile;
  }
  return true;
}

function validLogRange(params: unknown[] | undefined) {
  if (!params || params.length !== 1) return false;
  const filter = params?.[0];
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  const record = filter as Record<string, unknown>;
  const allowedKeys = new Set([
    "address",
    "blockHash",
    "fromBlock",
    "toBlock",
    "topics",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;

  const addresses = Array.isArray(record.address)
    ? record.address
    : record.address === undefined
      ? []
      : [record.address];
  if (
    addresses.length > MAX_LOG_ADDRESSES ||
    !addresses.every(isAddress)
  ) {
    return false;
  }
  if (record.topics !== undefined) {
    if (!Array.isArray(record.topics) || record.topics.length > 4) return false;
    for (const topic of record.topics) {
      if (topic === null || isHash(topic)) continue;
      if (
        !Array.isArray(topic) ||
        topic.length > MAX_TOPIC_OPTIONS ||
        !topic.every(isHash)
      ) {
        return false;
      }
    }
  }

  if (record.blockHash !== undefined) {
    return (
      isHash(record.blockHash) &&
      record.fromBlock === undefined &&
      record.toBlock === undefined
    );
  }
  if (typeof record.fromBlock !== "string" || typeof record.toBlock !== "string") {
    return false;
  }
  if (!isQuantity(record.fromBlock) || !isQuantity(record.toBlock)) {
    return false;
  }
  const from = BigInt(record.fromBlock);
  const to = BigInt(record.toBlock);
  return to >= from && to - from <= MAX_LOG_RANGE;
}

function validParams(method: string, params: unknown[] | undefined) {
  const values = params ?? [];
  if (
    [
      "eth_blockNumber",
      "eth_chainId",
      "eth_gasPrice",
      "eth_maxPriorityFeePerGas",
    ].includes(method)
  ) {
    return values.length === 0;
  }
  if (method === "eth_call" || method === "eth_estimateGas") {
    return validCallParams(params);
  }
  if (method === "eth_feeHistory") return validFeeHistoryParams(params);
  if (method === "eth_getLogs") return validLogRange(params);
  if (
    method === "eth_getTransactionByHash" ||
    method === "eth_getTransactionReceipt"
  ) {
    return values.length === 1 && isHash(values[0]);
  }
  if (method === "eth_getBlockByHash") {
    return values.length === 2 && isHash(values[0]) && values[1] === false;
  }
  if (method === "eth_getBlockByNumber") {
    return values.length === 2 && isBlockTag(values[0]) && values[1] === false;
  }
  if (
    method === "eth_getBalance" ||
    method === "eth_getCode" ||
    method === "eth_getTransactionCount"
  ) {
    return (
      values.length === 2 &&
      isAddress(values[0]) &&
      isBlockTag(values[1])
    );
  }
  if (method === "eth_getStorageAt") {
    return (
      values.length === 3 &&
      isAddress(values[0]) &&
      (isQuantity(values[1]) || isHash(values[1])) &&
      isBlockTag(values[2])
    );
  }
  return false;
}

export async function POST(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return rpcError(null, -32_600, "Cross-site RPC requests are not accepted.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return rpcError(null, -32_600, "Cross-origin RPC requests are not accepted.", 403);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return rpcError(null, -32_600, "Content-Type must be application/json.", 415);
  }

  const declaredSize = Number(request.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_REQUEST_BYTES) {
    return rpcError(null, -32_600, "Request is too large.", 413);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    return rpcError(null, -32_600, "Request is too large.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return rpcError(null, -32_700, "Invalid JSON.");
  }

  if (!isValidRequest(payload)) {
    return rpcError(null, -32_600, "Invalid JSON-RPC request.");
  }
  if (!ALLOWED_METHODS.has(payload.method)) {
    return rpcError(payload.id, -32_601, "Method is not available.", 403);
  }
  if (!validParams(payload.method, payload.params)) {
    return rpcError(
      payload.id,
      -32_602,
      "Method parameters exceed the relay's validated bounds.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let upstreamUrl: string;
  try {
    upstreamUrl = getRpcUrl();
  } catch {
    clearTimeout(timeout);
    return rpcError(payload.id, -32_603, "RPC relay is not configured.", 503);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      return rpcError(payload.id, -32_603, "RPC response exceeded the size limit.", 502);
    }

    let upstreamPayload: unknown;
    try {
      upstreamPayload = JSON.parse(text);
    } catch {
      return rpcError(payload.id, -32_603, "RPC provider returned an invalid response.", 502);
    }
    if (
      !upstreamPayload ||
      typeof upstreamPayload !== "object" ||
      Array.isArray(upstreamPayload) ||
      (upstreamPayload as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      (upstreamPayload as { id?: unknown }).id !== payload.id
    ) {
      return rpcError(payload.id, -32_603, "RPC provider response did not match the request.", 502);
    }

    return response(upstreamPayload, upstream.ok ? 200 : 502);
  } catch {
    return rpcError(payload.id, -32_603, "RPC provider is temporarily unavailable.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  return response(
    {
      error: "Use a JSON-RPC 2.0 POST request. Batch and transaction-broadcast methods are disabled.",
    },
    405,
    { Allow: "POST" },
  );
}
