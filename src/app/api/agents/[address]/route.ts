import { getAddress, isAddressEqual, type Address } from "viem";
import { NextResponse, type NextRequest } from "next/server";

import { resolveAgentConnection, type AgentConnection } from "@/lib/agent-connection";
import { agentConnectionsPageLimit } from "@/lib/agent-connections-server";
import { parseAutomationIntent, type ParsedAutomationIntent } from "@/lib/automation-records";
import type { RelayRecord } from "@/lib/relay";
import {
  listRelayIntentsPage,
  relayConfigured,
  RelayQueryError,
} from "@/lib/relay-server";
import { serverRateLimit } from "@/lib/relay-rate-limit";

/**
 * "What is this agent connected to?"
 *
 * This is a bounded relay-discovery projection, not current chain state. The
 * signed artifact is re-parsed and the capsule enforces its executor field at
 * execution, but a relay row still marked `open` may be stale after an onchain
 * cancellation, deadline, nonce use, or reorg. Callers must verify the capsule
 * at a pinned canonical block before treating a row as executable.
 *
 * It is public for the same reason the relay's list is public: an executor must
 * be able to discover the work it is allowed to do. The pin is already in the
 * signed intent and in the chain's logs, so this route publishes nothing that
 * was private.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface AgentZapConnection {
  zap: Address;
  owner: Address;
  connection: AgentConnection;
  authorizations: Array<{
    id: string;
    kind: RelayRecord["kind"];
    /** ISO — when the relay accepted the signature, not when it was signed. */
    publishedAt: string;
    authorizationId: string;
    recipient: Address;
    outAsset: Address;
    deadline: string;
    interval: string | null;
    maxRuns: number | null;
  }>;
}

export interface AgentConnectionsPayload {
  agent: Address;
  /** Capsules in this bounded relay page whose open rows name this agent, newest first. */
  connections: AgentZapConnection[];
  /** Distinct owners represented in this page. */
  owners: Address[];
  nextCursor: string | null;
  readAt: string;
  source: "relay";
  chainVerified: false;
  statusBasis: "relay-open-row";
  stalePossible: true;
  disclaimer: string;
}

export const AGENT_CONNECTIONS_PROVENANCE = {
  source: "relay",
  chainVerified: false,
  statusBasis: "relay-open-row",
  stalePossible: true,
  disclaimer:
    "Relay-discovered signed authorizations only. Open is not current chain status; verify the capsule at a pinned canonical block before execution.",
} as const;

const MAX_URL_CHARS = 2_048;
const RATE_WINDOW_MS = 10_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await params;
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment." }, { status: 503 });
  }
  const declaredBodyBytes = Number(request.headers.get("content-length") ?? "0");
  if (
    request.url.length > MAX_URL_CHARS
    || (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > 0)
  ) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }
  const quota = serverRateLimit(request, "agent-connections", 30, RATE_WINDOW_MS);
  if (quota.limited) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } },
    );
  }
  if (!HEX_ADDRESS.test(address)) {
    return NextResponse.json({ error: "address is not a 20-byte hex address." }, { status: 400 });
  }
  const agent = getAddress(address.toLowerCase());

  let records: RelayRecord[];
  let nextCursor: string | null;
  try {
    const page = await listRelayIntentsPage({
      status: "open",
      executor: agent,
      limit: agentConnectionsPageLimit(request.nextUrl.searchParams.get("limit")),
      cursor: request.nextUrl.searchParams.get("cursor"),
    });
    records = page.intents;
    nextCursor = page.nextCursor;
  } catch (error) {
    if (error instanceof RelayQueryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Fail closed: an empty connections list would read as "this agent is
    // connected to nothing", which is a claim, not an absence of data.
    return NextResponse.json({ error: "The intent relay could not be read right now." }, { status: 502 });
  }

  const byZap = new Map<string, AgentZapConnection>();
  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed) continue;
    // The relay's filter matched on a jsonb projection; re-check against the
    // parsed, checksummed value so a malformed row cannot widen the result.
    if (!isAddressEqual(parsed.executor, agent)) continue;

    const owner = getAddress(record.owner);
    const key = parsed.zap.toLowerCase();
    const entry = byZap.get(key) ?? {
      zap: parsed.zap,
      owner,
      connection: resolveAgentConnection(parsed.executor, owner),
      authorizations: [],
    };
    entry.authorizations.push({
      id: record.id,
      kind: record.kind,
      publishedAt: record.createdAt,
      authorizationId: parsed.authorizationId.toString(),
      recipient: parsed.recipient,
      outAsset: parsed.outAsset,
      deadline: parsed.deadline.toString(),
      interval: parsed.interval?.toString() ?? null,
      maxRuns: parsed.maxRuns,
    });
    byZap.set(key, entry);
  }

  const connections = [...byZap.values()];
  const owners = [...new Map(connections.map((c) => [c.owner.toLowerCase(), c.owner])).values()];

  const payload: AgentConnectionsPayload = {
    agent,
    connections,
    owners,
    nextCursor,
    readAt: new Date().toISOString(),
    ...AGENT_CONNECTIONS_PROVENANCE,
  };
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}

/** Re-parse the signed artifact rather than trusting the relay's own columns. */
function parseRecord(record: RelayRecord): ParsedAutomationIntent | null {
  try {
    const parsed = parseAutomationIntent(
      JSON.stringify({ kind: record.kind, intent: record.intent, signature: record.signature }),
    );
    if (!parsed) return null;
    return isAddressEqual(parsed.zap, getAddress(record.zap)) ? parsed : null;
  } catch {
    return null;
  }
}
