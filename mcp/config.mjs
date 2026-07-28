// Context assembly for the MCP server.
//
// Everything here is public except the executor key, which is read exactly the way the daemon reads
// it (executor/config.mjs) and is used for ONE thing: deriving the agent's address so a human can
// pin it. It is never used to sign, and this process has no code path that broadcasts.
import { createPublicClient, defineChain, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig, loadExecutorKey, ROBINHOOD_CHAIN_ID } from "../executor/config.mjs";

/** Where the read APIs live. Point at a local dev server to work against a branch. */
export const DEFAULT_APP_URL = "https://www.0xzaps.com";

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
    executorAddress: readExecutorAddress(),
  };
  return cached;
}

function readExecutorAddress() {
  try {
    const key = loadExecutorKey();
    return key ? privateKeyToAccount(key).address : null;
  } catch {
    // A malformed keyfile must not take the server down — every read-only tool
    // still works, and agent_identity will report read-only.
    return null;
  }
}

/**
 * GET one of the app's read APIs.
 *
 * Errors carry the status because "the capsule does not exist" (404) and "the RPC is down" (503) are
 * different answers, and an agent that collapses them will report the wrong thing to a human.
 */
export async function appGet(ctx, path, { timeoutMs = 15_000 } = {}) {
  const url = `${ctx.appUrl}${path}`;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error ? ` — ${body.error}` : "";
    } catch {
      // Non-JSON error body; the status alone has to carry it.
    }
    throw new Error(`GET ${path} returned HTTP ${response.status}${detail}`);
  }
  return response.json();
}
