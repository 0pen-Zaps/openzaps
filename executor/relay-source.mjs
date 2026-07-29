// The relay source: the executor's window onto the shared intent pool. Instead of only reading
// hand-delivered files from the local store, the daemon polls the hosted relay to DISCOVER open
// automations published by any owner — the "connected" half of the design. Relayed intents are
// treated as UNTRUSTED input exactly like files: each is re-validated through the same
// `validateIntentObject` gate, and every submission is re-verified on-chain by the capsule, so a
// hostile or buggy relay can only waste a simulation.
import { validateIntentObject } from "./store.mjs";
import { Buffer } from "node:buffer";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_BYTES = 512 * 1024;
const RELAY_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Fetch one bounded slice of open intents and normalize it into the same shape `tick()` consumes
 * for file intents ({ kind, intent (bigint fields), signature, file, source }).
 *
 * The caller durably stores `nextCursor` after processing the slice. That makes a large relay a
 * fair round-robin sweep instead of materializing every open authorization on every poll.
 */
export async function fetchRelayIntents(relayUrl, signal, fetchImpl = fetch, options = {}) {
  const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  const maxRows = positiveInteger(options.maxRows, DEFAULT_MAX_ROWS);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const rows = [];
  const seen = new Set();
  let cursor = options.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || !RELAY_CURSOR.test(cursor))) {
    throw new Error("relay cursor is malformed");
  }
  if (cursor) seen.add(cursor);
  let firstPage = true;
  let pages = 0;
  let bytes = 0;

  while (pages < maxPages && rows.length < maxRows) {
    const requestLimit = Math.min(pageSize, maxRows - rows.length);
    const params = new URLSearchParams({ status: "open", limit: String(requestLimit) });
    if (cursor) params.set("cursor", cursor);
    const res = await fetchImpl(`${relayUrl}/api/intents?${params.toString()}`, { signal });
    if (res.status === 503 && firstPage) {
      // Relay deployed but not yet backed by storage — not an error, just nothing to serve.
      return { ok: [], bad: [], disabled: true, nextCursor: cursor, pages: 0, bytes: 0 };
    }
    if (!res.ok) throw new Error(`relay list HTTP ${res.status}`);

    const declaredBytes = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes - bytes) {
      throw new Error(`relay page exceeds remaining ${maxBytes - bytes} byte budget`);
    }
    const text = await res.text();
    const pageBytes = Buffer.byteLength(text, "utf8");
    bytes += pageBytes;
    if (bytes > maxBytes) throw new Error(`relay poll exceeded ${maxBytes} byte budget`);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("relay list returned malformed JSON");
    }
    const pageRows = Array.isArray(body?.intents) ? body.intents : [];
    if (pageRows.length > requestLimit) {
      throw new Error(`relay page returned ${pageRows.length} rows for a ${requestLimit} row request`);
    }
    rows.push(...pageRows);
    pages += 1;

    const nextCursor =
      typeof body?.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : null;
    if (nextCursor) {
      if (!RELAY_CURSOR.test(nextCursor)) throw new Error("relay pagination returned a malformed cursor");
      if (seen.has(nextCursor)) throw new Error("relay pagination returned a repeated cursor");
      seen.add(nextCursor);
    }
    cursor = nextCursor;
    firstPage = false;
    if (!cursor) break;
  }

  const ok = [];
  const bad = [];
  for (const r of rows) {
    try {
      if (typeof r?.id !== "string" || !RELAY_ID.test(r.id)) throw new Error("relay row id is malformed");
      // Same schema gate as a file — decimal strings → bigints, kind/signature checked.
      const v = validateIntentObject({ kind: r.kind, intent: r.intent, signature: r.signature });
      const relayId = r.id.toLowerCase();
      ok.push({ ...v, file: `relay:${relayId}`, source: "relay", relayId });
    } catch (err) {
      const label = typeof r?.id === "string" && RELAY_ID.test(r.id) ? r.id.toLowerCase() : "?";
      bad.push({ file: `relay:${label}`, error: err.message });
    }
  }
  return { ok, bad, disabled: false, nextCursor: cursor, pages, bytes };
}

/**
 * Ask the relay to mark an intent consumed (best-effort). The relay only flips it if the nonce is
 * genuinely used on-chain, so this can never hide a live intent — it just garbage-collects dead
 * ones out of the open list. Fire-and-forget: a failure here is harmless.
 */
export async function markRelayConsumed(relayUrl, id, signal) {
  try {
    await fetch(`${relayUrl}/api/intents`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal,
    });
  } catch {
    // Best effort — the on-chain nonce already prevents re-execution regardless.
  }
}
