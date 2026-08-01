import { NextResponse, type NextRequest } from "next/server";

import {
  PolicyBlockedError,
  PolicyInputError,
  PolicyRpcError,
  compileExactPolicy,
  jsonSafePolicyArtifact,
  type ExactPolicyRequest,
} from "@/lib/policy-exact";
import {
  createExactPolicyChainReader,
  resolveExactPolicyProvider,
  type ExactPolicyProviderEnvironment,
  type ExactPolicyProviderResolution,
} from "@/lib/policy-exact-provider";
import { EXACT_POLICY_QUICKSTART_BODY } from "@/lib/policy-exact-example";
import { serverRateLimited } from "@/lib/relay-rate-limit";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 16_384;
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_IN_FLIGHT = 4;
const PUBLIC_STRESS_RPC_ERROR =
  "The RPC provider could not serve this stress quote; no output was synthesized.";
let inFlight = 0;

type ExactPolicyApiEnvironment = ExactPolicyProviderEnvironment & {
  readonly OPENZAPS_EXACT_POLICY_API_ENABLED?: string;
  readonly OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED?: string;
};

type ReadyProvider = Extract<ExactPolicyProviderResolution, { ready: true }>;

export type ExactPolicyApiReadiness =
  | { readonly ready: true; readonly provider: ReadyProvider }
  | { readonly ready: false; readonly reason: "feature-disabled" }
  | {
      readonly ready: false;
      readonly reason: "provider-unavailable";
      readonly providerIssue: Extract<ExactPolicyProviderResolution, { ready: false }>["reason"];
    };

export function exactPolicyApiReadiness(
  env: ExactPolicyApiEnvironment = process.env,
): ExactPolicyApiReadiness {
  const featureEnabled = env.NODE_ENV !== "production"
    ? env.OPENZAPS_EXACT_POLICY_API_ENABLED !== "false"
    : (
        env.OPENZAPS_EXACT_POLICY_API_ENABLED === "true"
        && env.OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED === "true"
      );
  if (!featureEnabled) return { ready: false, reason: "feature-disabled" };

  const provider = resolveExactPolicyProvider(env);
  if (!provider.ready) {
    return {
      ready: false,
      reason: "provider-unavailable",
      providerIssue: provider.reason,
    };
  }
  return { ready: true, provider };
}

export function exactPolicyApiEnabled(
  env: ExactPolicyApiEnvironment = process.env,
): boolean {
  return exactPolicyApiReadiness(env).ready;
}

/** Warm-instance concurrency guard; durable WAF quota remains the production boundary. */
export function acquireExactPolicySlot(): (() => void) | null {
  if (inFlight >= MAX_IN_FLIGHT) return null;
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  };
}

export async function readExactPolicyBody(request: NextRequest): Promise<ExactPolicyRequest> {
  try {
    return await readBoundedJsonBody(request, MAX_BODY_BYTES) as ExactPolicyRequest;
  } catch (error) {
    if (error instanceof BoundedJsonBodyError) {
      throw new ExactPolicyBodyError(
        error.status === 413 ? "Body too large." : "Request body must be valid JSON.",
        error.status,
      );
    }
    throw new ExactPolicyBodyError("Request body must be valid JSON.", 400);
  }
}

export class ExactPolicyBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
  }
}

function unavailableResponse(
  readiness: Exclude<ExactPolicyApiReadiness, { ready: true }>,
  includeBroadcast: boolean,
): NextResponse {
  const disabled = readiness.reason === "feature-disabled";
  return NextResponse.json(
    {
      error: disabled
        ? "The chain-exact policy API is disabled on this deployment."
        : "The chain-exact policy RPC provider is unavailable on this deployment.",
      code: disabled ? "FEATURE_DISABLED" : "PROVIDER_UNAVAILABLE",
      ...(includeBroadcast ? { broadcast: false } : {}),
    },
    {
      status: 503,
      headers: { ...noStore, "retry-after": disabled ? "3600" : "300" },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Upstream error objects can include their request URL. Keep the public artifact
 * useful while replacing nonessential stress-quote diagnostics at the API edge.
 */
export function publicExactPolicyArtifact(artifact: unknown): unknown {
  const safe = jsonSafePolicyArtifact(artifact);
  if (!isRecord(safe) || !Array.isArray(safe.stressCases)) return safe;
  return {
    ...safe,
    stressCases: safe.stressCases.map((entry) => {
      if (!isRecord(entry) || entry.rpcFailure !== true) return entry;
      return { ...entry, error: PUBLIC_STRESS_RPC_ERROR };
    }),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const readiness = exactPolicyApiReadiness();
  if (!readiness.ready) return unavailableResponse(readiness, true);
  if (serverRateLimited(request, "exact-policy", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many policy simulations.", code: "RATE_LIMITED", broadcast: false },
      { status: 429, headers: { ...noStore, "retry-after": "60" } },
    );
  }
  const release = acquireExactPolicySlot();
  if (!release) {
    return NextResponse.json(
      { error: "Policy simulation capacity is busy.", code: "CAPACITY_BUSY", broadcast: false },
      { status: 503, headers: { ...noStore, "retry-after": "5" } },
    );
  }

  try {
    const body = await readExactPolicyBody(request);
    const client = createExactPolicyChainReader(readiness.provider);
    const artifact = await compileExactPolicy(client, body);
    return NextResponse.json(publicExactPolicyArtifact(artifact), { headers: noStore });
  } catch (error) {
    if (error instanceof ExactPolicyBodyError) {
      return NextResponse.json(
        { error: error.message, code: "INVALID_POLICY_INPUT", broadcast: false },
        { status: error.status, headers: noStore },
      );
    }
    if (error instanceof PolicyInputError) {
      return NextResponse.json(
        { error: error.message, code: error.code, broadcast: false },
        { status: 400, headers: noStore },
      );
    }
    if (error instanceof PolicyBlockedError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          evidence: jsonSafePolicyArtifact(error.evidence ?? {}),
          broadcast: false,
        },
        { status: 422, headers: noStore },
      );
    }
    if (error instanceof PolicyRpcError) {
      return NextResponse.json(
        {
          error: "The chain-exact policy RPC could not complete this simulation.",
          code: error.code,
          rpcFailure: true,
          stage: error.stage,
          broadcast: false,
          note: "No synthetic quote was substituted. Retry when the RPC can serve one canonical block.",
        },
        { status: 503, headers: noStore },
      );
    }

    return NextResponse.json(
      {
        error: "Policy simulation failed before an exact artifact could be produced.",
        code: "POLICY_SIMULATION_FAILED",
        broadcast: false,
      },
      { status: 500, headers: noStore },
    );
  } finally {
    release();
  }
}

export function GET(): NextResponse {
  const readiness = exactPolicyApiReadiness();
  if (!readiness.ready) return unavailableResponse(readiness, false);
  return NextResponse.json(
    {
      endpoint: "/api/policies/simulate",
      method: "POST",
      mode: "chain-exact",
      body: EXACT_POLICY_QUICKSTART_BODY,
      returns: [
        "one canonical block number and hash",
        "live adapter and token allowlist results",
        "adapter and implementation runtime code hashes",
        "a seeded-vault totalSupply proof at the same pinned block when required",
        "an exact block-pinned route quote",
        "the Solidity-exact policy hash",
        "an unsigned EIP-712 OpenZapIntent draft",
        "an ephemeral eth_call factory simulation",
        "block-pinned stress quotes with explicit RPC-failure labels",
      ],
      authority: {
        signs: false,
        broadcasts: false,
        acceptsDiscoveryCredentialsAsAuthority: false,
      },
    },
    { headers: noStore },
  );
}
