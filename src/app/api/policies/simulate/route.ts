import { createPublicClient, http } from "viem";
import { NextResponse, type NextRequest } from "next/server";

import {
  PolicyBlockedError,
  PolicyInputError,
  PolicyRpcError,
  compileExactPolicy,
  jsonSafePolicyArtifact,
  type ExactPolicyRequest,
  type PolicyChainReader,
} from "@/lib/policy-exact";
import { serverRateLimited } from "@/lib/relay-rate-limit";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import { ROBINHOOD_RPC_URL, robinhoodChain } from "@/lib/robinhood";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 15_000 }),
});

const noStore = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 16_384;
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

export function exactPolicyApiEnabled(
  env: {
    NODE_ENV?: string;
    OPENZAPS_EXACT_POLICY_API_ENABLED?: string;
    OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED?: string;
  } = process.env,
): boolean {
  if (env.NODE_ENV !== "production") return env.OPENZAPS_EXACT_POLICY_API_ENABLED !== "false";
  return (
    env.OPENZAPS_EXACT_POLICY_API_ENABLED === "true"
    && env.OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED === "true"
  );
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!exactPolicyApiEnabled()) {
    return NextResponse.json(
      {
        error: "The chain-exact policy API is disabled on this deployment.",
        code: "FEATURE_DISABLED",
        broadcast: false,
      },
      { status: 503, headers: { ...noStore, "retry-after": "3600" } },
    );
  }
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
    const artifact = await compileExactPolicy(client as unknown as PolicyChainReader, body);
    return NextResponse.json(jsonSafePolicyArtifact(artifact), { headers: noStore });
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
          error: error.message,
          code: error.code,
          rpcFailure: true,
          stage: error.stage,
          detail: error.detail,
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
  if (!exactPolicyApiEnabled()) {
    return NextResponse.json(
      { error: "The chain-exact policy API is disabled on this deployment.", code: "FEATURE_DISABLED" },
      { status: 503, headers: { ...noStore, "retry-after": "3600" } },
    );
  }
  return NextResponse.json(
    {
      endpoint: "/api/policies/simulate",
      method: "POST",
      mode: "chain-exact",
      body: {
        routeId: "robinhood-v4-weth-zaps",
        owner: "0x0000000000000000000000000000000000000001",
        amount: "0.01",
        slippageBps: 150,
      },
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
