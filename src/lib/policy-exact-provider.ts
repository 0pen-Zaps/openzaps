import "server-only";

import { createPublicClient, http } from "viem";

import type { PolicyChainReader } from "@/lib/policy-exact";
import { robinhoodChain } from "@/lib/robinhood";

/**
 * This fixed unauthenticated origin is the only implicit development fallback.
 * In particular, the exact-policy server never inherits a browser-bundled
 * NEXT_PUBLIC RPC URL, which may have been configured with provider credentials.
 */
export const EXACT_POLICY_PUBLIC_RPC_FALLBACK =
  "https://rpc.mainnet.chain.robinhood.com";

const exactPolicyChain = {
  ...robinhoodChain,
  // Keep browser configuration out of the server client's chain metadata too;
  // the explicit transport below is the only selected provider.
  rpcUrls: {
    default: { http: [EXACT_POLICY_PUBLIC_RPC_FALLBACK] },
  },
};

export type ExactPolicyProviderEnvironment = {
  readonly NODE_ENV?: string;
  readonly OPENZAPS_EXACT_POLICY_RPC_URL?: string;
  /** Deliberately ignored; retained in the type so tests can prove that boundary. */
  readonly NEXT_PUBLIC_ROBINHOOD_RPC_URL?: string;
};

export type ExactPolicyProviderResolution =
  | {
      readonly ready: true;
      readonly rpcUrl: string;
      readonly source: "server-configuration" | "local-public-fallback";
    }
  | {
      readonly ready: false;
      readonly reason: "missing-server-rpc" | "invalid-server-rpc";
    };

type ReadyExactPolicyProvider = Extract<ExactPolicyProviderResolution, { ready: true }>;

/**
 * Resolve the RPC transport without ever returning a configured value in a
 * failure. Production has no implicit provider; local and test runs use one
 * deterministic public fallback only when the server-only setting is absent.
 */
export function resolveExactPolicyProvider(
  environment: ExactPolicyProviderEnvironment = process.env,
): ExactPolicyProviderResolution {
  const configured = environment.OPENZAPS_EXACT_POLICY_RPC_URL?.trim() ?? "";
  if (!configured) {
    if (environment.NODE_ENV === "production") {
      return { ready: false, reason: "missing-server-rpc" };
    }
    return {
      ready: true,
      rpcUrl: EXACT_POLICY_PUBLIC_RPC_FALLBACK,
      source: "local-public-fallback",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { ready: false, reason: "invalid-server-rpc" };
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    return { ready: false, reason: "invalid-server-rpc" };
  }

  return {
    ready: true,
    rpcUrl: parsed.toString(),
    source: "server-configuration",
  };
}

/** Construct the narrow read-only client only after the provider gate passes. */
export function createExactPolicyChainReader(
  provider: ReadyExactPolicyProvider,
): PolicyChainReader {
  return createPublicClient({
    chain: exactPolicyChain,
    transport: http(provider.rpcUrl, { retryCount: 2, timeout: 15_000 }),
  }) as unknown as PolicyChainReader;
}
