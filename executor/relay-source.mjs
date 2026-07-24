// The relay source: the executor's window onto the shared intent pool. Instead of only reading
// hand-delivered files from the local store, the daemon polls the hosted relay to DISCOVER open
// automations published by any owner — the "connected" half of the design. Relayed intents are
// treated as UNTRUSTED input exactly like files: each is re-validated through the same
// `validateIntentObject` gate, and every submission is re-verified on-chain by the capsule, so a
// hostile or buggy relay can only waste a simulation.
import { validateIntentObject } from "./store.mjs";

/**
 * Fetch open intents from the relay and normalize them into the same shape `tick()` consumes for
 * file intents ({ kind, intent (bigint fields), signature, file, source }). Returns { ok, bad }.
 */
export async function fetchRelayIntents(relayUrl, signal) {
  const res = await fetch(`${relayUrl}/api/intents?status=open`, { signal });
  if (res.status === 503) {
    // Relay deployed but not yet backed by storage — not an error, just nothing to serve.
    return { ok: [], bad: [], disabled: true };
  }
  if (!res.ok) throw new Error(`relay list HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.intents) ? body.intents : [];
  const ok = [];
  const bad = [];
  for (const r of rows) {
    try {
      // Same schema gate as a file — decimal strings → bigints, kind/signature checked.
      const v = validateIntentObject({ kind: r.kind, intent: r.intent, signature: r.signature });
      ok.push({ ...v, file: `relay:${r.id}`, source: "relay", relayId: r.id });
    } catch (err) {
      bad.push({ file: `relay:${r.id ?? "?"}`, error: err.message });
    }
  }
  return { ok, bad, disabled: false };
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
