import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import {
  parseRelaySubmission,
  relayIntentNonce,
  type RelayIntentKind,
  type RelaySubmission,
} from "@/lib/relay";
import { RelayAdmissionError, verifyRelaySubmissionAdmission } from "@/lib/relay-admission";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";
import {
  RelayQueryError,
  insertRelayIntentImmutable,
  listRelayIntentsPage,
  relayConfigured,
  relayHeaders,
  relayUrl,
  RELAY_TABLE,
  type RelayListQuery,
} from "@/lib/relay-server";
import { serverRateLimited } from "@/lib/relay-rate-limit";
import { ROBINHOOD_RPC_URL, openZapV3Abi, robinhoodChain } from "@/lib/robinhood";

// The relay endpoint. POST publishes a signed standing intent to the shared pool; GET lists open
// intents for executors to discover; PATCH garbage-collects intents that are already consumed
// on-chain. The relay is a convenience coordinator, NOT trusted for safety — the capsule
// re-verifies everything on-chain — but it still refuses to store anything that isn't a genuinely
// owner-signed intent for a real on-chain zap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

const TABLE = RELAY_TABLE;
const MAX_BODY_BYTES = 16_384; // a signed intent is ~1.5KB; 16KB is generous headroom

const sb = relayUrl;
const sbHeaders = relayHeaders;

// Best-effort in-memory rate limit. On serverless this is per warm instance, not global — a first
// line of defense against burst abuse of the unauthenticated endpoint, not a hard guarantee.
const RL_WINDOW_MS = 10_000;
const RL_MAX = 20;
function rateLimited(req: NextRequest): boolean {
  return serverRateLimited(req, "intents", RL_MAX, RL_WINDOW_MS);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment." }, { status: 503 });
  }
  if (rateLimited(request)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedJsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  let sub: RelaySubmission;
  try {
    sub = parseRelaySubmission(raw);
  } catch (err) {
    return NextResponse.json({ error: `Invalid intent: ${(err as Error).message}` }, { status: 422 });
  }

  const chainId = Number(sub.intent.chainId);
  const zap = sub.intent.zap as Address;
  let owner: string;
  try {
    owner = (await verifyRelaySubmissionAdmission(publicClient, sub)).owner;
  } catch (error) {
    if (error instanceof RelayAdmissionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "Canonical capsule provenance could not be established; relay admission failed closed." },
      { status: 503 },
    );
  }

  // ---- store. A signed authorization is immutable. Plain INSERT wins once;
  //      a unique conflict is idempotent only when the existing canonical
  //      intent + signature is identical. No upsert can overwrite terms or
  //      reopen a consumed/expired authorization. ----
  const record = {
    zap,
    owner,
    chainId,
    kind: sub.kind,
    nonce: relayIntentNonce(sub),
    intent: sub.intent,
    signature: sub.signature,
    status: "open" as const,
  };
  try {
    const result = await insertRelayIntentImmutable(record);
    if (result.kind === "conflict") {
      return NextResponse.json(
        { error: "A different signed intent already occupies this zap/kind/nonce." },
        { status: 409 },
      );
    }
    if (result.kind === "idempotent") {
      return NextResponse.json(
        {
          id: result.id,
          stored: false,
          idempotent: true,
          status: result.status,
        },
        { status: 200 },
      );
    }
    return NextResponse.json({ id: result.id, stored: true }, { status: 201 });
  } catch (cause) {
    return NextResponse.json(
      {
        error: "Relay storage failed.",
        detail: cause instanceof Error ? cause.message.slice(0, 300) : "",
      },
      { status: 502 },
    );
  }
}

const DEFAULT_GET_LIMIT = 100;
const MAX_GET_LIMIT = 500;

function pageLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_GET_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw)) throw new RelayQueryError("limit", `limit must be an integer from 1 to ${MAX_GET_LIMIT}.`);
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_GET_LIMIT) {
    throw new RelayQueryError("limit", `limit must be an integer from 1 to ${MAX_GET_LIMIT}.`);
  }
  return limit;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment.", intents: [] }, { status: 503 });
  }
  // GET was the only unauthenticated path with no limiter at all, and it is the
  // one an agent polls hardest — every executor and every MCP client discovers
  // work through it. Cursor consumers may legitimately need many consecutive pages.
  if (serverRateLimited(request, "intents-get", 120, RL_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many requests.", intents: [] }, { status: 429 });
  }

  const params = request.nextUrl.searchParams;
  try {
    const query: RelayListQuery = {
      status: params.get("status") as RelayListQuery["status"],
      owner: params.get("owner"),
      zap: params.get("zap"),
      executor: params.get("executor"),
      limit: pageLimit(params.get("limit")),
      cursor: params.get("cursor"),
    };
    const page = await listRelayIntentsPage(query);
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof RelayQueryError) {
      return NextResponse.json({ error: error.message, intents: [] }, { status: 400 });
    }
    return NextResponse.json({ error: "Relay list failed.", intents: [] }, { status: 502 });
  }
}

// Garbage-collect an intent whose nonce is used or signed deadline has passed. Permissionless and
// safe: both conditions are read from chain/signed data, so a caller can never hide live authority.
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment." }, { status: 503 });
  }
  if (rateLimited(request)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  let id: string;
  try {
    const body = (await readBoundedJsonBody(request, MAX_BODY_BYTES)) as { id?: unknown };
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/.test(body.id)) throw new Error("id must be a uuid");
    id = body.id;
  } catch (error) {
    if (error instanceof BoundedJsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: `Bad request: ${(error as Error).message}` }, { status: 400 });
  }

  const lookup = await fetch(sb(`${TABLE}?select=zap,kind,nonce,status,intent&id=eq.${id}`), { headers: sbHeaders(), cache: "no-store" });
  if (!lookup.ok) return NextResponse.json({ error: "Lookup failed." }, { status: 502 });
  const found = (await lookup.json()) as Array<{
    zap: string;
    kind: RelayIntentKind;
    nonce: string;
    status: string;
    intent: Record<string, string | boolean>;
  }>;
  const row = found[0];
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (row.status === "consumed" || row.status === "expired") {
    return NextResponse.json({ consumed: true, expired: row.status === "expired", already: true });
  }

  let used = false;
  try {
    used = await publicClient.readContract({
      address: row.zap as Address,
      abi: openZapV3Abi,
      functionName: "nonceUsed",
      args: [BigInt(row.nonce)],
    });
  } catch {
    return NextResponse.json({ error: "Could not read on-chain nonce state." }, { status: 502 });
  }
  let nextStatus: "consumed" | "expired" = "consumed";
  if (!used) {
    const deadline = BigInt(String(row.intent.deadline));
    let chainNow: bigint;
    try {
      chainNow = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    } catch {
      return NextResponse.json({ error: "Could not read chain time." }, { status: 502 });
    }
    if (chainNow <= deadline) {
      return NextResponse.json({ error: "Intent is still live on-chain — refusing to consume." }, { status: 409 });
    }
    nextStatus = "expired";
  }

  const upd = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: "PATCH",
    headers: sbHeaders({ prefer: "return=minimal" }),
    body: JSON.stringify({ status: nextStatus }),
  });
  if (!upd.ok) return NextResponse.json({ error: "Update failed." }, { status: 502 });
  return NextResponse.json({ consumed: true, expired: nextStatus === "expired" });
}
