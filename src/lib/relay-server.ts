import { getAddress, isAddress } from "viem";

import type { RelayIntentKind, RelayRecord, RelayStatus } from "@/lib/relay";

/**
 * Server-only access to the relay's storage.
 *
 * Extracted so the route that publishes intents and the route that answers
 * "what is this agent connected to?" share one description of the table. The
 * alternative — a route fetching its own sibling over HTTP — costs a round trip
 * and invents a failure mode that has nothing to do with the data.
 *
 * Nothing here is a security boundary. The relay is a convenience coordinator:
 * the capsule re-verifies every intent on-chain, so the worst a corrupted row
 * can do is waste an executor's simulation.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const RELAY_TABLE = "zap_intents";

export function relayConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function relayUrl(path: string): string {
  return `${SUPABASE_URL}/rest/v1/${path}`;
}

export function relayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY as string,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

export interface RelayListQuery {
  status?: RelayStatus | null;
  owner?: string | null;
  zap?: string | null;
  executor?: string | null;
  limit: number;
}

/** Thrown when a caller-supplied address is not an address. Maps to a 400. */
export class RelayQueryError extends Error {
  constructor(readonly param: string) {
    super(`${param} must be a valid address.`);
    this.name = "RelayQueryError";
  }
}

/**
 * Build the PostgREST filter suffix for a list query.
 *
 * `owner` and `zap` are plain columns holding checksummed addresses. `executor`
 * is the GENERATED `lower(intent->>'executor')` column — the executor lives
 * inside the signed jsonb, and its case is whatever the signer wrote, so the
 * comparison has to happen on a normalized projection or it silently misses
 * pins that differ only by case.
 */
export function relayListFilter(query: RelayListQuery): string {
  const parts: string[] = [];
  if (query.status === "open" || query.status === "consumed") parts.push(`&status=eq.${query.status}`);

  for (const [param, column, lowercase] of [
    ["owner", "owner", false],
    ["zap", "zap", false],
    ["executor", "executor", true],
  ] as const) {
    const raw = query[param];
    if (raw === null || raw === undefined) continue;
    if (!isAddress(raw)) throw new RelayQueryError(param);
    parts.push(`&${column}=eq.${lowercase ? raw.toLowerCase() : getAddress(raw)}`);
  }
  return parts.join("");
}

interface RelayRow {
  id: string;
  zap: string;
  owner: string;
  chain_id: number;
  kind: RelayIntentKind;
  intent: Record<string, string | boolean>;
  signature: `0x${string}`;
  status: RelayStatus;
  created_at: string;
}

/**
 * List stored intents. Throws `RelayQueryError` for a malformed address and a
 * plain Error when the store is unreachable — callers must NOT turn the latter
 * into an empty list, because "no rows" and "could not read" are different
 * claims and only one of them is safe to render.
 */
export async function listRelayIntents(query: RelayListQuery): Promise<RelayRecord[]> {
  const filter = relayListFilter(query);
  const res = await fetch(
    relayUrl(`${RELAY_TABLE}?select=*&order=created_at.desc&limit=${query.limit}${filter}`),
    { headers: relayHeaders(), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Relay list failed (${res.status}).`);

  const rows = (await res.json()) as RelayRow[];
  return rows.map((row) => ({
    id: row.id,
    zap: row.zap,
    owner: row.owner,
    chainId: row.chain_id,
    kind: row.kind,
    intent: row.intent,
    signature: row.signature,
    status: row.status,
    createdAt: row.created_at,
  }));
}
