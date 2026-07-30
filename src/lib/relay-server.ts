import { getAddress, isAddress } from "viem";
import { Buffer } from "node:buffer";

import {
  canonicalRelayUint,
  canonicalizeRelayIntentDecimals,
  type RelayIntentKind,
  type RelayRecord,
  type RelayStatus,
} from "@/lib/relay";
import {
  openZapsSupabaseConfiguration,
  requireOpenZapsSupabaseConfiguration,
} from "@/lib/supabase-config";

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

export const RELAY_TABLE = "zap_intents";

export function relayConfigured(): boolean {
  return openZapsSupabaseConfiguration() !== null;
}

export function relayUrl(path: string): string {
  return new URL(
    path,
    requireOpenZapsSupabaseConfiguration().restUrl,
  ).toString();
}

export function relayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { serviceRoleKey } = requireOpenZapsSupabaseConfiguration();
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
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
  cursor?: string | null;
}

/** Thrown when a caller-supplied address is not an address. Maps to a 400. */
export class RelayQueryError extends Error {
  constructor(readonly param: string, message = `${param} must be a valid address.`) {
    super(message);
    this.name = "RelayQueryError";
  }
}

interface RelayCursor {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CURSOR_BYTES = 512;

/** Opaque keyset cursor. Its fields are validated again when decoded; it carries no authority. */
export function encodeRelayCursor(cursor: RelayCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

export function decodeRelayCursor(raw: string): RelayCursor {
  if (!raw || raw.length > MAX_CURSOR_BYTES) {
    throw new RelayQueryError("cursor", "cursor is malformed.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.createdAt !== "string" ||
      !RFC3339.test(parsed.createdAt) ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor fields");
    }
    // Preserve Postgres sub-millisecond precision. Normalizing through Date would truncate it and
    // could skip rows that share the same millisecond.
    return { createdAt: parsed.createdAt, id: parsed.id.toLowerCase() };
  } catch {
    throw new RelayQueryError("cursor", "cursor is malformed.");
  }
}

/**
 * Build the PostgREST filter suffix for a list query.
 *
 * `owner` is a plain column holding the canonical chain-returned checksum.
 * `zap` is stored lowercase so the case-sensitive unique index represents EVM
 * identity. `executor` is the GENERATED `lower(intent->>'executor')` column.
 */
export function relayListFilter(query: RelayListQuery): string {
  const parts: string[] = [];
  if (query.status === "open" || query.status === "consumed" || query.status === "expired") {
    parts.push(`&status=eq.${query.status}`);
  }

  for (const [param, column, lowercase] of [
    ["owner", "owner", false],
    ["zap", "zap", true],
    ["executor", "executor", true],
  ] as const) {
    const raw = query[param];
    if (raw === null || raw === undefined) continue;
    if (!isAddress(raw)) throw new RelayQueryError(param);
    parts.push(`&${column}=eq.${lowercase ? raw.toLowerCase() : getAddress(raw)}`);
  }
  return parts.join("");
}

/**
 * Build one stable PostgREST keyset page.
 *
 * `created_at` is not unique, so the UUID is the deterministic tie-breaker. Inserts that happen
 * while a client is paging sort ahead of its cursor and cannot shift or duplicate older rows.
 */
export function relayListPath(query: RelayListQuery): string {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw new RelayQueryError("limit", "limit must be an integer from 1 to 500.");
  }

  const params = new URLSearchParams({
    select: "id,zap,owner,chain_id,kind,intent,signature,status,created_at",
    order: "created_at.desc,id.desc",
    // One look-ahead row tells the server whether another page exists without a count query.
    limit: String(query.limit + 1),
  });
  if (query.status === "open" || query.status === "consumed" || query.status === "expired") {
    params.set("status", `eq.${query.status}`);
  }

  for (const [param, column, lowercase] of [
    ["owner", "owner", false],
    ["zap", "zap", true],
    ["executor", "executor", true],
  ] as const) {
    const raw = query[param];
    if (raw === null || raw === undefined) continue;
    if (!isAddress(raw)) throw new RelayQueryError(param);
    params.set(column, `eq.${lowercase ? raw.toLowerCase() : getAddress(raw)}`);
  }

  if (query.cursor) {
    const cursor = decodeRelayCursor(query.cursor);
    params.set(
      "or",
      `(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`,
    );
  }
  return `${RELAY_TABLE}?${params.toString()}`;
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

export interface RelayListPage {
  intents: RelayRecord[];
  nextCursor: string | null;
}

export interface RelaySignedArtifact {
  zap: string;
  owner: string;
  chainId: number;
  kind: RelayIntentKind;
  nonce: string;
  intent: Record<string, string | boolean>;
  signature: string;
}

export type RelayStoreRecord = RelaySignedArtifact & {
  status: "open";
};

export type RelayStoreResult =
  | { kind: "created"; id: string }
  | { kind: "idempotent"; id: string; status: RelayStatus }
  | { kind: "conflict" };

/**
 * Insert once without merge-upsert semantics. The unique index may race two
 * publishers; after a conflict, a read decides exact idempotency.
 */
export async function insertRelayIntentImmutable(record: RelayStoreRecord): Promise<RelayStoreResult> {
  const stored = {
    zap: record.zap,
    owner: record.owner,
    chain_id: record.chainId,
    kind: record.kind,
    nonce: record.nonce,
    intent: record.intent,
    signature: record.signature,
    status: record.status,
  };
  const response = await fetch(relayUrl(RELAY_TABLE), {
    method: "POST",
    headers: relayHeaders({ prefer: "return=representation" }),
    body: JSON.stringify(stored),
  });
  if (response.ok) {
    const rows = (await response.json()) as Array<{ id: string }>;
    if (!rows[0]?.id) throw new Error("Relay storage returned no row.");
    return { kind: "created", id: rows[0].id };
  }
  if (response.status !== 409) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Relay storage failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const params = new URLSearchParams({
    select: "id,zap,owner,chain_id,kind,nonce,intent,signature,status",
    zap: `eq.${record.zap}`,
    kind: `eq.${record.kind}`,
    nonce: `eq.${record.nonce}`,
    limit: "1",
  });
  const lookup = await fetch(relayUrl(`${RELAY_TABLE}?${params.toString()}`), {
    headers: relayHeaders(),
    cache: "no-store",
  });
  if (!lookup.ok) throw new Error(`Relay conflict lookup failed (${lookup.status}).`);
  const rows = (await lookup.json()) as Array<{
    id: string;
    zap: string;
    owner: string;
    chain_id: number;
    kind: RelayIntentKind;
    nonce: string;
    intent: Record<string, string | boolean>;
    signature: string;
    status: RelayStatus;
  }>;
  const existing = rows[0];
  if (
    !existing
    || !relaySignedArtifactsEqual(
      {
        zap: existing.zap,
        owner: existing.owner,
        chainId: existing.chain_id,
        kind: existing.kind,
        nonce: existing.nonce,
        intent: existing.intent,
        signature: existing.signature,
      },
      record,
    )
  ) {
    return { kind: "conflict" };
  }
  return { kind: "idempotent", id: existing.id, status: existing.status };
}

/**
 * Compare the canonical bytes represented by two signed relay artifacts.
 *
 * Object key order and hex casing are not EIP-712 semantics, so normalize
 * those before comparing. Status is intentionally absent: an idempotent
 * republish may observe a terminal row, but it can never reopen it.
 */
export function relaySignedArtifactsEqual(
  left: RelaySignedArtifact,
  right: RelaySignedArtifact,
): boolean {
  return canonicalArtifact(left) === canonicalArtifact(right);
}

function canonicalArtifact(artifact: RelaySignedArtifact): string {
  return JSON.stringify(sortRelayValue({
    zap: normalizeHex(artifact.zap),
    owner: normalizeHex(artifact.owner),
    chainId: artifact.chainId,
    kind: artifact.kind,
    nonce: /^[0-9]{1,78}$/.test(artifact.nonce)
      ? canonicalRelayUint(artifact.nonce)
      : artifact.nonce,
    intent: canonicalizeRelayIntentDecimals(artifact.kind, artifact.intent),
    signature: normalizeHex(artifact.signature),
  }));
}

function sortRelayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRelayValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? normalizeHex(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortRelayValue(nested)]),
  );
}

function normalizeHex(value: string): string {
  return /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value;
}

function relayRowToRecord(row: RelayRow): RelayRecord {
  return {
    id: row.id,
    zap: row.zap,
    owner: row.owner,
    chainId: row.chain_id,
    kind: row.kind,
    intent: row.intent,
    signature: row.signature,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * List stored intents. Throws `RelayQueryError` for a malformed address and a
 * plain Error when the store is unreachable — callers must NOT turn the latter
 * into an empty list, because "no rows" and "could not read" are different
 * claims and only one of them is safe to render.
 */
export async function listRelayIntentsPage(query: RelayListQuery): Promise<RelayListPage> {
  const res = await fetch(relayUrl(relayListPath(query)), { headers: relayHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Relay list failed (${res.status}).`);

  const rows = (await res.json()) as RelayRow[];
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    intents: pageRows.map(relayRowToRecord),
    nextCursor:
      rows.length > query.limit && last ? encodeRelayCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
