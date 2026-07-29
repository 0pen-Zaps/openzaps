// Context assembly for the MCP server.
//
// Everything here is public. In particular, this process never reads an
// executor key just to derive an address: a public identifier and a private
// execution credential are different concerns and stay in different processes.
import { createPublicClient, defineChain, fallback, getAddress, http, isAddress } from "viem";

import { loadConfig, ROBINHOOD_CHAIN_ID } from "../executor/config.mjs";

/** Where the read APIs live. Point at a local dev server to work against a branch. */
export const DEFAULT_APP_URL = "https://www.0xzaps.com";
export const DEFAULT_APP_RESPONSE_MAX_BYTES = 1_048_576;
const ERROR_RESPONSE_MAX_BYTES = 16_384;

let cached = null;

export async function buildContext() {
  if (cached) return cached;

  const cfg = loadConfig();
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === ROBINHOOD_CHAIN_ID ? "Robinhood Chain" : `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls.length > 0 ? cfg.rpcUrls : [cfg.rpcUrl] } },
  });
  const transport =
    cfg.rpcUrls.length > 1 ? fallback(cfg.rpcUrls.map((url) => http(url))) : http(cfg.rpcUrls[0] ?? cfg.rpcUrl);

  cached = {
    cfg,
    appUrl: (process.env.OPENZAPS_APP_URL ?? DEFAULT_APP_URL).replace(/\/$/, ""),
    publicClient: createPublicClient({ chain, transport }),
    /**
     * The agent's own address, or null when no key is configured.
     *
     * A null here is the read-only posture and it is load-bearing: without a key
     * this server cannot even name an executor to pin, which is the honest state
     * for an agent that is not set up to submit anything.
     */
    executorAddress: readPublicAgentAddress(),
  };
  return cached;
}

function readPublicAgentAddress() {
  const value = process.env.OPENZAPS_AGENT_ADDRESS;
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

/**
 * GET one of the app's read APIs.
 *
 * Errors carry the status because "the capsule does not exist" (404) and "the RPC is down" (503) are
 * different answers, and an agent that collapses them will report the wrong thing to a human.
 */
export async function appGet(
  ctx,
  path,
  { timeoutMs = 15_000, maxBytes = DEFAULT_APP_RESPONSE_MAX_BYTES } = {},
) {
  const url = `${ctx.appUrl}${path}`;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  let body;
  try {
    body = await boundedResponseJson(
      response,
      response.ok ? maxBytes : Math.min(maxBytes, ERROR_RESPONSE_MAX_BYTES),
      `GET ${path}`,
    );
  } catch (error) {
    if (response.ok) throw error;
    throw new Error(`GET ${path} returned HTTP ${response.status}; its error body was invalid or too large`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const detail =
      typeof body?.error === "string" && body.error.length <= 1_024 ? ` — ${body.error}` : "";
    throw new Error(`GET ${path} returned HTTP ${response.status}${detail}`);
  }
  return body;
}

export async function boundedResponseJson(response, maxBytes, label = "response") {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("response byte limit is invalid");
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
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
        throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
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
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}
