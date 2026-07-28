import { getAddress, isAddressEqual, type Address } from "viem";
import { NextResponse, type NextRequest } from "next/server";

import { resolveAgentConnection, type AgentConnection } from "@/lib/agent-connection";
import { parseAutomationIntent, type ParsedAutomationIntent } from "@/lib/automation-records";
import type { RelayRecord } from "@/lib/relay";
import { listRelayIntents, relayConfigured } from "@/lib/relay-server";

/**
 * "What is this agent connected to?"
 *
 * The answer is derived, never stored: an agent is connected to a capsule iff a
 * standing intent the owner signed names it in `executor`, and the capsule
 * enforces that field itself (`ExecutorMismatch`). This route is therefore a
 * projection of signatures, not a registry — there is no write side, and no way
 * for it to disagree with the chain.
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
  /** Capsules whose open authorizations name this agent, newest first. */
  connections: AgentZapConnection[];
  /** Distinct owners who pinned this agent. */
  owners: Address[];
  readAt: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await params;
  if (!HEX_ADDRESS.test(address)) {
    return NextResponse.json({ error: `${address} is not a 20-byte hex address.` }, { status: 400 });
  }
  const agent = getAddress(address.toLowerCase());

  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment." }, { status: 503 });
  }

  let records: RelayRecord[];
  try {
    records = await listRelayIntents({ status: "open", executor: agent, limit: 500 });
  } catch {
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
    readAt: new Date().toISOString(),
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
