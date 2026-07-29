// The intent relay: the shared, hosted pool that connects owners to executors. After an owner
// signs a standing intent in the Automate tab, the app PUBLISHES it here (no file, no localhost);
// executors POLL here to DISCOVER open automations across all users. This module is the isomorphic
// contract shared by three consumers — the Automate UI (publish), the `/api/intents` route
// (validate + store), and the executor daemon (poll) — so all three agree on the wire shape.
//
// TRUST MODEL: the relay is a convenience coordinator, NOT a security dependency. Every intent it
// carries is re-verified on-chain by the capsule (signature, policy hash, cadence, price
// condition, net-of-fee floor), so a malicious or censoring relay can never forge, steal, or force
// a bad trade. The worst it can do is withhold — and the file-drop / direct-submit paths remain as
// fallbacks. That is why this file does SCHEMA validation only; the authority check (does the
// signature recover to the zap's owner, does the policy hash match on-chain) lives server-side in
// the route, and the real check lives in the contract.
import type { Address, Hex } from "viem";

export type RelayIntentKind = "recurring" | "recurring-relative" | "recurring-stack" | "trigger";
export type RelayStatus = "open" | "consumed" | "expired";

/** Exactly the intent-file shape the executor already consumes, plus the kind + signature. */
export interface RelaySubmission {
  kind: RelayIntentKind;
  /** All uint fields are DECIMAL STRINGS (no JSON numbers — a uint256 loses precision as a double). */
  intent: Record<string, string | boolean>;
  signature: Hex;
}

/** A stored, relayed intent as returned by GET /api/intents. */
export interface RelayRecord extends RelaySubmission {
  id: string;
  zap: string;
  owner: string;
  chainId: number;
  status: RelayStatus;
  createdAt: string;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
// Cap the signature length too: a genuine ERC-1271 wrapped sig is well under 1KB, and an unbounded
// hex blob is a cheap way to inflate request work before validation.
const HEX_SIG = /^0x(?:[0-9a-fA-F]{2}){65,2000}$/; // 65-byte ECDSA up to a ~2KB ERC-1271 wrapped sig
// A uint256 is at most 78 decimal digits. Bounding this is load-bearing: an unbounded decimal
// string reaches a synchronous BigInt() parse in the API route, and a multi-MB value blocks the
// event loop. No legitimate field exceeds 78 digits.
const DECIMAL = /^[0-9]{1,78}$/;

type Rule = "dec" | "bool" | "addr" | "hash";

// Mirrors executor/store.mjs KIND_FIELDS and src/lib/executions.ts field order EXACTLY, so an
// intent published here round-trips through the executor's own validator byte-for-byte.
const COMMON: [string, Rule][] = [
  ["zap", "addr"],
  ["chainId", "dec"],
  ["validAfter", "dec"],
  ["deadline", "dec"],
  ["recipient", "addr"],
  ["executor", "addr"],
  ["maxGas", "dec"],
  ["maxFeePerGas", "dec"],
  ["policyHash", "hash"],
  ["outAsset", "addr"],
];

const KIND_FIELDS: Record<RelayIntentKind, [string, Rule][]> = {
  recurring: [
    ...COMMON,
    ["seriesId", "dec"],
    ["interval", "dec"],
    ["maxRuns", "dec"],
    ["minOutPerRun", "dec"],
  ],
  "recurring-relative": [
    ...COMMON,
    ["seriesId", "dec"],
    ["interval", "dec"],
    ["maxRuns", "dec"],
    ["priceSource", "addr"],
    ["maxSlippageBps", "dec"],
  ],
  // Mirrors RecurringStackIntent: the relative fields plus the two stack fields, in signed order.
  "recurring-stack": [
    ...COMMON,
    ["seriesId", "dec"],
    ["interval", "dec"],
    ["maxRuns", "dec"],
    ["priceSource", "addr"],
    ["maxSlippageBps", "dec"],
    ["stackPriceSource", "addr"],
    ["stackBps", "dec"],
  ],
  trigger: [
    ...COMMON,
    ["nonce", "dec"],
    ["priceSource", "addr"],
    ["baselinePriceX96", "dec"],
    ["thresholdBps", "dec"],
    ["above", "bool"],
    ["minOut", "dec"],
  ],
};

function checkField(name: string, rule: Rule, value: unknown): string | boolean {
  if (rule === "bool") {
    if (typeof value !== "boolean") throw new Error(`intent.${name}: expected boolean`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`intent.${name}: expected a string`);
  const re = rule === "dec" ? DECIMAL : rule === "addr" ? HEX_ADDR : HEX_32;
  if (!re.test(value)) throw new Error(`intent.${name}: malformed`);
  // EIP-712 uint values are numbers, not textual spellings of numbers. Store one canonical
  // spelling so "01" and "1" cannot become distinct relay rows for the same on-chain nonce.
  // Addresses and bytes32 values are bytes too: casing is not signed meaning.
  // Lowercase storage keeps the relay's case-sensitive unique/filter columns
  // aligned with their EVM identity.
  return rule === "dec" ? canonicalRelayUint(value) : value.toLowerCase();
}

/** Canonical decimal spelling for a schema-bounded uint string. */
export function canonicalRelayUint(value: string): string {
  return BigInt(value).toString();
}

/**
 * Normalize known uint fields without requiring a complete intent.
 *
 * The immutable-store comparator uses this for rows admitted before canonical decimal parsing was
 * introduced. Unknown or malformed values are deliberately preserved so they cannot accidentally
 * compare equal.
 */
export function canonicalizeRelayIntentDecimals(
  kind: RelayIntentKind,
  intent: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const decimalFields = new Set(
    KIND_FIELDS[kind]
      .filter(([, rule]) => rule === "dec")
      .map(([name]) => name),
  );
  return Object.fromEntries(
    Object.entries(intent).map(([name, value]) => [
      name,
      decimalFields.has(name) && typeof value === "string" && DECIMAL.test(value)
        ? canonicalRelayUint(value)
        : value,
    ]),
  );
}

/**
 * Validate a raw submission body (schema only — no chain, no signature recovery). Returns a clean
 * submission with exactly the allowed fields, or throws a precise error. Shared by the route and
 * any client that wants to pre-check before publishing.
 */
export function parseRelaySubmission(body: unknown): RelaySubmission {
  if (typeof body !== "object" || body === null) throw new Error("body must be a JSON object");
  const raw = body as Record<string, unknown>;
  const kind = raw.kind;
  if (
    kind !== "recurring" &&
    kind !== "recurring-relative" &&
    kind !== "recurring-stack" &&
    kind !== "trigger"
  ) {
    throw new Error('kind must be "recurring", "recurring-relative", "recurring-stack", or "trigger"');
  }
  if (typeof raw.signature !== "string" || !HEX_SIG.test(raw.signature)) throw new Error("signature: malformed");
  if (typeof raw.intent !== "object" || raw.intent === null) throw new Error("intent: missing");
  const src = raw.intent as Record<string, unknown>;

  const intent: Record<string, string | boolean> = {};
  for (const [name, rule] of KIND_FIELDS[kind]) {
    if (!(name in src)) throw new Error(`intent.${name}: missing`);
    intent[name] = checkField(name, rule, src[name]);
  }
  return { kind, intent, signature: raw.signature as Hex };
}

/** The nonce field that identifies an intent for dedup: seriesId for recurring kinds, nonce for trigger. */
export function relayIntentNonce(sub: RelaySubmission): string {
  return String(sub.kind === "trigger" ? sub.intent.nonce : sub.intent.seriesId);
}

// ---- isomorphic client (works in the browser and in the executor's Node) ----

/** Publish a signed intent to the relay. `baseUrl` is "" for same-origin (the app). */
export async function publishIntent(sub: RelaySubmission, baseUrl = ""): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay refused the intent (HTTP ${res.status})`);
  }
  return (await res.json()) as { id: string };
}

export interface RelayIntentPage {
  intents: RelayRecord[];
  nextCursor: string | null;
}

export interface RelayIntentPageOptions {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

const DEFAULT_RELAY_PAGE_LIMIT = 50;
const MAX_RELAY_PAGE_LIMIT = 100;
const RELAY_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

async function fetchIntentPage(
  baseUrl: string,
  params: URLSearchParams,
  options: RelayIntentPageOptions,
): Promise<RelayIntentPage> {
  const limit = options.limit ?? DEFAULT_RELAY_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RELAY_PAGE_LIMIT) {
    throw new Error(`relay page limit must be an integer from 1 to ${MAX_RELAY_PAGE_LIMIT}`);
  }
  const cursor = options.cursor ?? null;
  if (cursor !== null && !RELAY_CURSOR.test(cursor)) throw new Error("relay cursor is malformed");

  const pageParams = new URLSearchParams(params);
  pageParams.set("limit", String(limit));
  if (cursor) pageParams.set("cursor", cursor);
  const res = await fetch(`${baseUrl}/api/intents?${pageParams.toString()}`, { signal: options.signal });
  if (!res.ok) throw new Error(`relay list failed (HTTP ${res.status})`);
  const body = (await res.json()) as { intents?: unknown; nextCursor?: unknown };
  const intents = Array.isArray(body.intents) ? body.intents as RelayRecord[] : [];
  if (intents.length > limit) throw new Error("relay page exceeded the requested row bound");
  const nextCursor =
    typeof body.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : null;
  if (nextCursor !== null && !RELAY_CURSOR.test(nextCursor)) {
    throw new Error("relay pagination returned a malformed cursor");
  }
  if (nextCursor !== null && nextCursor === cursor) {
    throw new Error("relay pagination returned a repeated cursor");
  }
  return { intents, nextCursor };
}

/** Fetch one bounded, newest-first open-intent page. Follow `nextCursor` explicitly if needed. */
export async function fetchOpenIntentPage(
  baseUrl: string,
  options: RelayIntentPageOptions = {},
): Promise<RelayIntentPage> {
  return fetchIntentPage(baseUrl, new URLSearchParams({ status: "open" }), options);
}

/** Fetch one bounded, newest-first owner page for cross-device UI state. */
export async function fetchOwnerIntentPage(
  owner: Address,
  baseUrl = "",
  options: RelayIntentPageOptions = {},
): Promise<RelayIntentPage> {
  return fetchIntentPage(baseUrl, new URLSearchParams({ owner }), options);
}

/**
 * Mark a relayed intent terminal so it drops out of the open list. Permissionless BY DESIGN: the
 * route only flips the row if the nonce is used onchain or the signed deadline passed in chain
 * time, so a caller can never hide a still-live intent.
 */
export async function consumeIntent(id: string, baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/intents`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
    signal,
  });
  return res.ok;
}
