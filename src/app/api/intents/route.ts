import { NextResponse, type NextRequest } from "next/server";
import {
  createPublicClient,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  parseRelaySubmission,
  relayIntentNonce,
  type RelayIntentKind,
  type RelayRecord,
  type RelaySubmission,
} from "@/lib/relay";
import { RECURRING_INTENT_TYPES, TRIGGER_INTENT_TYPES, openZapV3Domain } from "@/lib/executions";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL, openZapV3Abi, robinhoodChain } from "@/lib/robinhood";

// The relay endpoint. POST publishes a signed standing intent to the shared pool; GET lists open
// intents for executors to discover; PATCH garbage-collects intents that are already consumed
// on-chain. The relay is a convenience coordinator, NOT trusted for safety — the capsule
// re-verifies everything on-chain — but it still refuses to store anything that isn't a genuinely
// owner-signed intent for a real on-chain zap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "zap_intents";
const MAX_BODY_BYTES = 16_384; // a signed intent is ~1.5KB; 16KB is generous headroom

function relayConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}
function sb(path: string): string {
  return `${SUPABASE_URL}/rest/v1/${path}`;
}
function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY as string,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

// Best-effort in-memory rate limit. On serverless this is per warm instance, not global — a first
// line of defense against burst abuse of the unauthenticated endpoint, not a hard guarantee. A
// global limiter (Upstash/KV) is the production hardening; noted for follow-up.
const RL_WINDOW_MS = 10_000;
const RL_MAX = 20;
const rlBucket = new Map<string, { count: number; resetAt: number }>();
function rateLimited(req: NextRequest): boolean {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const b = rlBucket.get(ip);
  if (!b || now > b.resetAt) {
    rlBucket.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    if (rlBucket.size > 5_000) for (const [k, v] of rlBucket) if (now > v.resetAt) rlBucket.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > RL_MAX;
}

const TYPES: Record<RelayIntentKind, { types: object; primaryType: string }> = {
  recurring: { types: RECURRING_INTENT_TYPES, primaryType: "RecurringIntent" },
  trigger: { types: TRIGGER_INTENT_TYPES, primaryType: "TriggerIntent" },
};

/** Convert the string/bool intent into the typed message viem needs (fields are already bounded). */
function toTypedMessage(kind: RelayIntentKind, intent: Record<string, string | boolean>): Record<string, unknown> {
  const fields = (TYPES[kind].types as Record<string, { name: string; type: string }[]>)[TYPES[kind].primaryType];
  const message: Record<string, unknown> = {};
  for (const { name, type } of fields) {
    const v = intent[name];
    if (type === "bool") message[name] = v === true;
    else if (type.startsWith("uint") || type.startsWith("int")) message[name] = BigInt(v as string);
    else message[name] = v;
  }
  return message;
}

async function readBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  return JSON.parse(text);
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
    raw = await readBody(request);
  } catch (err) {
    const tooLarge = (err as Error).message === "body too large";
    return NextResponse.json({ error: tooLarge ? "Body too large." : "Body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }

  let sub: RelaySubmission;
  try {
    sub = parseRelaySubmission(raw);
  } catch (err) {
    return NextResponse.json({ error: `Invalid intent: ${(err as Error).message}` }, { status: 422 });
  }

  const chainId = Number(sub.intent.chainId);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    return NextResponse.json({ error: `Intent chainId ${chainId} != ${ROBINHOOD_CHAIN_ID}.` }, { status: 422 });
  }
  const zap = sub.intent.zap as Address;

  // ---- authority. Read the owner FIRST (one RPC); verify the signature against it BEFORE the
  //      second read, so a junk submission (random signature, real or fake zap) costs one RPC and
  //      short-circuits — the policyHash read only happens once the signature already checks out. ----
  let owner: Address;
  try {
    owner = await publicClient.readContract({ address: zap, abi: openZapV3Abi, functionName: "owner" });
  } catch {
    return NextResponse.json({ error: "Zap not found on-chain (no v3 capsule at that address)." }, { status: 422 });
  }

  // The dynamic (per-kind) typed-data shape defeats viem's strict generics; coerce the whole arg.
  const typedData = {
    domain: openZapV3Domain(chainId, zap),
    types: TYPES[sub.kind].types,
    primaryType: TYPES[sub.kind].primaryType,
    message: toTypedMessage(sub.kind, sub.intent),
  };

  let signerOk = false;
  try {
    // EOA: pure recovery, no RPC.
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: sub.signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    signerOk = isAddressEqual(recovered, owner);
  } catch {
    // Not a plain 65-byte ECDSA sig — fall through to the contract-wallet path.
  }
  if (!signerOk) {
    try {
      // ERC-1271 (Safe / smart wallet): one more RPC, only for a non-EOA owner.
      signerOk = await publicClient.verifyTypedData({
        address: owner,
        ...typedData,
        signature: sub.signature,
      } as Parameters<typeof publicClient.verifyTypedData>[0]);
    } catch {
      signerOk = false;
    }
  }
  if (!signerOk) {
    return NextResponse.json({ error: "Signature does not recover to the zap owner." }, { status: 422 });
  }

  let onchainPolicyHash: Hex;
  try {
    onchainPolicyHash = await publicClient.readContract({ address: zap, abi: openZapV3Abi, functionName: "policyHash" });
  } catch {
    return NextResponse.json({ error: "Could not read the zap's policy." }, { status: 422 });
  }
  if ((sub.intent.policyHash as string).toLowerCase() !== onchainPolicyHash.toLowerCase()) {
    return NextResponse.json({ error: "Intent policyHash does not match the on-chain zap." }, { status: 422 });
  }

  // ---- store (idempotent: on_conflict names the unique (zap,kind,nonce) index so a re-publish
  //      MERGES instead of erroring on the PK). ----
  const record = {
    zap,
    owner,
    chain_id: chainId,
    kind: sub.kind,
    nonce: relayIntentNonce(sub),
    intent: sub.intent,
    signature: sub.signature,
    status: "open",
  };
  const res = await fetch(sb(`${TABLE}?on_conflict=zap,kind,nonce`), {
    method: "POST",
    headers: sbHeaders({ prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json({ error: `Relay storage failed (${res.status}).`, detail: detail.slice(0, 300) }, { status: 502 });
  }
  const rows = (await res.json()) as { id: string }[];
  return NextResponse.json({ id: rows[0]?.id ?? relayIntentNonce(sub), stored: true }, { status: 201 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment.", intents: [] }, { status: 503 });
  }
  const status = request.nextUrl.searchParams.get("status");
  const filter = status === "open" || status === "consumed" ? `&status=eq.${status}` : "";
  const res = await fetch(sb(`${TABLE}?select=*&order=created_at.desc&limit=500${filter}`), {
    headers: sbHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json({ error: `Relay list failed (${res.status}).`, intents: [] }, { status: 502 });
  }
  const rows = (await res.json()) as Array<{
    id: string;
    zap: string;
    owner: string;
    chain_id: number;
    kind: RelayIntentKind;
    intent: Record<string, string | boolean>;
    signature: Hex;
    status: "open" | "consumed";
    created_at: string;
  }>;
  const intents: RelayRecord[] = rows.map((r) => ({
    id: r.id,
    zap: r.zap,
    owner: r.owner,
    chainId: r.chain_id,
    kind: r.kind,
    intent: r.intent,
    signature: r.signature,
    status: r.status,
    createdAt: r.created_at,
  }));
  return NextResponse.json({ intents });
}

// Garbage-collect an intent whose nonce is ALREADY used on-chain. Permissionless and safe: the
// row only flips to consumed if the chain confirms the nonce is spent, so a caller can never hide a
// still-live intent — only reap genuinely dead ones. This keeps the open-list bounded so old
// finished intents can't crowd out live ones under the list cap.
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!relayConfigured()) {
    return NextResponse.json({ error: "The intent relay is not configured on this deployment." }, { status: 503 });
  }
  if (rateLimited(request)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  let id: string;
  try {
    const body = (await readBody(request)) as { id?: unknown };
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/.test(body.id)) throw new Error("id must be a uuid");
    id = body.id;
  } catch (err) {
    return NextResponse.json({ error: `Bad request: ${(err as Error).message}` }, { status: 400 });
  }

  const lookup = await fetch(sb(`${TABLE}?select=zap,kind,nonce,status&id=eq.${id}`), { headers: sbHeaders(), cache: "no-store" });
  if (!lookup.ok) return NextResponse.json({ error: "Lookup failed." }, { status: 502 });
  const found = (await lookup.json()) as Array<{ zap: string; kind: RelayIntentKind; nonce: string; status: string }>;
  const row = found[0];
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (row.status === "consumed") return NextResponse.json({ consumed: true, already: true });

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
  if (!used) return NextResponse.json({ error: "Intent is still live on-chain — refusing to consume." }, { status: 409 });

  const upd = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: "PATCH",
    headers: sbHeaders({ prefer: "return=minimal" }),
    body: JSON.stringify({ status: "consumed" }),
  });
  if (!upd.ok) return NextResponse.json({ error: "Update failed." }, { status: 502 });
  return NextResponse.json({ consumed: true });
}
