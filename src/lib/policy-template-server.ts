import {
  getAddress,
  isAddress,
  keccak256,
  recoverMessageAddress,
  toBytes,
  type Address,
  type Hex,
} from "viem";

import {
  isPolicyTemplateHash,
  policyTemplatePublishMessage,
  policyTemplateSubscriptionReadMessage,
  policyTemplateSubscriptionMessage,
  POLICY_TEMPLATE_SUBSCRIPTION_READ_NONCE,
  POLICY_TEMPLATE_SUBSCRIPTION_TTL_SECONDS,
  preparePolicyTemplate,
  type PreparedPolicyTemplate,
  type PublicPolicyTemplate,
} from "@/lib/policy-templates";
import { readBoundedJsonBody } from "@/lib/request-body";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEMPLATE_TABLE = "policy_templates";
const SUBSCRIPTION_RPC = "set_policy_template_subscription";
const SUBSCRIPTION_SNAPSHOT_RPC = "get_policy_template_subscription_snapshot";
const TEMPLATE_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAX_PAGE_SIZE = 50;
const MAX_SUBSCRIPTION_SNAPSHOT_BYTES = 32_768;

type TemplateRow = {
  content_hash: string;
  schema_version: string;
  version: number;
  parent_hash: string | null;
  name: string;
  summary: string;
  chain: unknown;
  compiled_hash: string;
  publisher: string | null;
  publisher_verified: boolean;
  visible: boolean;
  moderation_status: "pending" | "approved" | "hidden" | "rejected";
  created_at: string;
  subscription_count?: number | null;
};

export type PolicyTemplateCursor = {
  createdAt: string;
  contentHash: string;
};

export type PolicyTemplatePage = {
  templates: PublicPolicyTemplate[];
  nextCursor: string | null;
};

export type PolicyTemplateAdmission = {
  publisher: Address;
  signature: Hex;
};

export type PolicyTemplateSubscriptionAdmission = {
  subscriber: Address;
  subscriberKey: string;
  signature: Hex;
  subscribed: boolean;
  expectedVersion: number;
  expiresAt: number;
};

export type PolicyTemplateSubscriptionSnapshot = {
  subscriber: Address;
  version: number;
  contentHashes: string[];
};

export type PolicyTemplateSubscriptionMutation = {
  version: number;
  subscribed: boolean;
};

export type PolicyTemplateSubscriptionAdmissionCode =
  | "INVALID_SUBSCRIBER"
  | "INVALID_CONTENT_HASH"
  | "INVALID_ACTION"
  | "INVALID_VERSION"
  | "INVALID_EXPIRY"
  | "SIGNATURE_EXPIRED"
  | "EXPIRY_TOO_FAR"
  | "INVALID_SIGNATURE"
  | "SIGNER_MISMATCH"
  | "INVALID_READ_NONCE"
  | "VERSION_CONFLICT"
  | "SUBSCRIBER_LIMIT"
  | "TEMPLATE_LIMIT"
  | "GLOBAL_LIMIT"
  | "VERSION_EXHAUSTED";

export class PolicyTemplateSubscriptionAdmissionError extends Error {
  constructor(
    message: string,
    readonly code: PolicyTemplateSubscriptionAdmissionCode,
    readonly status: 409 | 422 | 429 = 422,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "PolicyTemplateSubscriptionAdmissionError";
  }
}

export function policyRegistryConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function policyTemplatePublishingEnabled(
  env: {
    NODE_ENV?: string;
    OPENZAPS_POLICY_TEMPLATE_PUBLISHING_ENABLED?: string;
  } = process.env,
): boolean {
  return env.NODE_ENV !== "production"
    || env.OPENZAPS_POLICY_TEMPLATE_PUBLISHING_ENABLED === "true";
}

export function policyTemplateSubscriptionsEnabled(
  env: {
    NODE_ENV?: string;
    OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED?: string;
    OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_DURABLE_QUOTA_ENABLED?: string;
  } = process.env,
): boolean {
  if (env.NODE_ENV !== "production") {
    return env.OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED !== "false";
  }
  return (
    env.OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED === "true"
    && env.OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_DURABLE_QUOTA_ENABLED === "true"
  );
}

export async function listPolicyTemplates(limit: number, cursor: string | null = null): Promise<PolicyTemplatePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error(`Policy registry page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const decodedCursor = cursor ? decodePolicyTemplateCursor(cursor) : null;
  const params = new URLSearchParams({
    select:
      "content_hash,schema_version,version,parent_hash,name,summary,chain,compiled_hash,publisher,publisher_verified,visible,moderation_status,created_at,subscription_count",
    publisher_verified: "eq.true",
    visible: "eq.true",
    moderation_status: "eq.approved",
    // Immutable keyset order: new publications cannot push older entries off
    // the first page, and a content hash breaks equal-timestamp ties.
    order: "created_at.asc,content_hash.asc",
    limit: String(limit + 1),
  });
  if (decodedCursor) {
    params.set(
      "or",
      `(created_at.gt.${decodedCursor.createdAt},and(created_at.eq.${decodedCursor.createdAt},content_hash.gt.${decodedCursor.contentHash}))`,
    );
  }
  const response = await fetch(
    registryUrl(`${TEMPLATE_TABLE}?${params.toString()}`),
    { headers: registryHeaders(), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Policy registry list failed (${response.status}).`);
  const rows = (await response.json()) as TemplateRow[];
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    templates: pageRows.map(publicTemplateFromRow),
    nextCursor:
      rows.length > limit && last
        ? encodePolicyTemplateCursor({ createdAt: last.created_at, contentHash: last.content_hash })
        : null,
  };
}

export async function getPolicyTemplate(contentHash: string): Promise<PublicPolicyTemplate | null> {
  if (!isPolicyTemplateHash(contentHash)) return null;
  const response = await fetch(
    registryUrl(
      `${TEMPLATE_TABLE}?select=content_hash,schema_version,version,parent_hash,name,summary,chain,compiled_hash,publisher,publisher_verified,visible,moderation_status,created_at,subscription_count&publisher_verified=eq.true&visible=eq.true&moderation_status=eq.approved&content_hash=eq.${contentHash.toLowerCase()}&limit=1`,
    ),
    { headers: registryHeaders(), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Policy registry lookup failed (${response.status}).`);
  const rows = (await response.json()) as TemplateRow[];
  return rows[0] ? publicTemplateFromRow(rows[0]) : null;
}

export async function insertPolicyTemplate(
  template: PreparedPolicyTemplate,
  admission: PolicyTemplateAdmission,
): Promise<PublicPolicyTemplate> {
  const response = await fetch(registryUrl(TEMPLATE_TABLE), {
    method: "POST",
    headers: registryHeaders({ prefer: "return=representation" }),
    body: JSON.stringify({
      content_hash: template.contentHash,
      schema_version: template.schema,
      version: template.version,
      parent_hash: template.parentHash,
      name: template.name,
      summary: template.summary,
      chain: template.chain,
      compiled_hash: template.compiledHash,
      publisher: admission.publisher.toLowerCase(),
      publisher_signature: admission.signature.toLowerCase(),
      publisher_verified: true,
      visible: true,
      moderation_status: "approved",
      moderated_at: new Date().toISOString(),
      moderation_note: "Admitted by content-bound wallet signature.",
    }),
  });
  if (response.status === 409) {
    const existing = await getPolicyTemplate(template.contentHash);
    if (existing) return existing;
  }
  if (!response.ok) throw new Error(`Policy registry insert failed (${response.status}).`);
  const rows = (await response.json()) as TemplateRow[];
  if (!rows[0]) throw new Error("Policy registry insert returned no row.");
  return publicTemplateFromRow(rows[0]);
}

/** Recover the signer from the content-bound publication message. */
export async function verifyPolicyTemplatePublisher(
  template: PreparedPolicyTemplate,
  publisherInput: unknown,
  signatureInput: unknown,
): Promise<PolicyTemplateAdmission> {
  if (typeof publisherInput !== "string" || !isAddress(publisherInput)) {
    throw new Error("Publisher must be a valid wallet address.");
  }
  if (typeof signatureInput !== "string" || !TEMPLATE_SIGNATURE.test(signatureInput)) {
    throw new Error("Publisher signature must be a 65-byte wallet signature.");
  }
  const publisher = getAddress(publisherInput);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: policyTemplatePublishMessage(template),
      signature: signatureInput as Hex,
    });
  } catch {
    throw new Error("Publisher signature could not be recovered.");
  }
  if (recovered.toLowerCase() !== publisher.toLowerCase()) {
    throw new Error("Publisher signature does not match the publisher wallet.");
  }
  return { publisher, signature: signatureInput as Hex };
}

export function encodePolicyTemplateCursor(cursor: PolicyTemplateCursor): string {
  if (!validCursorFields(cursor)) throw new Error("Invalid policy registry cursor.");
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePolicyTemplateCursor(value: string): PolicyTemplateCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("Invalid policy registry cursor.");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || !validCursorFields(decoded as PolicyTemplateCursor)) {
      throw new Error("invalid");
    }
    return decoded as PolicyTemplateCursor;
  } catch {
    throw new Error("Invalid policy registry cursor.");
  }
}

export async function setPolicyTemplateSubscription(
  subscriberKey: string,
  contentHash: string,
  subscribed: boolean,
  expectedVersion: number,
  expiresAt: number,
): Promise<PolicyTemplateSubscriptionMutation> {
  if (!isSubscriberKey(subscriberKey) || !isPolicyTemplateHash(contentHash)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Invalid exact-version subscription.",
      "INVALID_CONTENT_HASH",
    );
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization version is invalid.",
      "INVALID_VERSION",
    );
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 1) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization expiry is invalid.",
      "INVALID_EXPIRY",
    );
  }

  const response = await fetch(registryUrl(`rpc/${SUBSCRIPTION_RPC}`), {
    method: "POST",
    headers: registryHeaders(),
    body: JSON.stringify({
      p_subscriber_key: subscriberKey,
      p_content_hash: contentHash.toLowerCase(),
      p_subscribed: subscribed,
      p_expected_version: expectedVersion,
      p_expires_at: expiresAt,
    }),
  });
  if (!response.ok) throw new Error(`Policy subscription write failed (${response.status}).`);

  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error("Policy subscription write returned an invalid admission result.");
  }
  const result = rows[0] as Record<string, unknown>;
  const code = result.result_code;
  const version = parseSubscriptionVersion(result.resulting_version);
  const resultingSubscribed = result.resulting_subscribed;

  if (code === "applied" && version !== null && typeof resultingSubscribed === "boolean") {
    return { version, subscribed: resultingSubscribed };
  }
  if (code === "version_conflict" && version !== null) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription state changed before this authorization was applied. Sync and sign the new version.",
      "VERSION_CONFLICT",
      409,
      version,
    );
  }
  if (code === "subscriber_limit") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "This wallet has reached the 256-template subscription limit.",
      "SUBSCRIBER_LIMIT",
      429,
      version ?? undefined,
    );
  }
  if (code === "template_limit") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "This exact template has reached the 5,000-subscription limit.",
      "TEMPLATE_LIMIT",
      429,
      version ?? undefined,
    );
  }
  if (code === "global_limit") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "The registry has reached its 50,000-subscription limit.",
      "GLOBAL_LIMIT",
      429,
      version ?? undefined,
    );
  }
  if (code === "expired") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization expired before it could be applied.",
      "SIGNATURE_EXPIRED",
    );
  }
  if (code === "invalid_expiry") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization expiry exceeds the five-minute limit.",
      "EXPIRY_TOO_FAR",
    );
  }
  if (code === "version_exhausted") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization version is exhausted.",
      "VERSION_EXHAUSTED",
      409,
      version ?? undefined,
    );
  }
  throw new Error("Policy subscription write returned an unknown admission result.");
}

function isSubscriberKey(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Recover and deterministically pseudonymize the wallet that authorized this exact state. */
export async function verifyPolicyTemplateSubscriber(
  subscriberInput: unknown,
  contentHashInput: unknown,
  subscribedInput: unknown,
  expectedVersionInput: unknown,
  expiresAtInput: unknown,
  signatureInput: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<PolicyTemplateSubscriptionAdmission> {
  if (typeof subscriberInput !== "string" || !isAddress(subscriberInput)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber must be a valid wallet address.",
      "INVALID_SUBSCRIBER",
    );
  }
  if (!isPolicyTemplateHash(contentHashInput)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Invalid exact-version subscription.",
      "INVALID_CONTENT_HASH",
    );
  }
  if (typeof subscribedInput !== "boolean") {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription action must be subscribe or unsubscribe.",
      "INVALID_ACTION",
    );
  }
  const expectedVersion = parseSubscriptionVersion(expectedVersionInput);
  if (expectedVersion === null) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization version is invalid.",
      "INVALID_VERSION",
    );
  }
  const expiresAt = verifySubscriptionExpiry(expiresAtInput, nowSeconds);
  if (typeof signatureInput !== "string" || !TEMPLATE_SIGNATURE.test(signatureInput)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature must be a 65-byte wallet signature.",
      "INVALID_SIGNATURE",
    );
  }
  const subscriber = getAddress(subscriberInput);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: policyTemplateSubscriptionMessage({
        subscriber,
        contentHash: contentHashInput,
        subscribed: subscribedInput,
        expectedVersion,
        expiresAt,
      }),
      signature: signatureInput as Hex,
    });
  } catch {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature could not be recovered.",
      "INVALID_SIGNATURE",
    );
  }
  if (recovered.toLowerCase() !== subscriber.toLowerCase()) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature does not match the subscriber wallet.",
      "SIGNER_MISMATCH",
    );
  }
  return {
    subscriber,
    subscriberKey: subscriberKeyForAddress(subscriber),
    signature: signatureInput as Hex,
    subscribed: subscribedInput,
    expectedVersion,
    expiresAt,
  };
}

/** Verify a short-lived wallet proof before returning any wallet-scoped state. */
export async function verifyPolicyTemplateSubscriberRead(
  subscriberInput: unknown,
  requestNonceInput: unknown,
  expiresAtInput: unknown,
  signatureInput: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Pick<PolicyTemplateSubscriptionAdmission, "subscriber" | "subscriberKey" | "signature" | "expiresAt">> {
  if (typeof subscriberInput !== "string" || !isAddress(subscriberInput)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber must be a valid wallet address.",
      "INVALID_SUBSCRIBER",
    );
  }
  if (
    typeof requestNonceInput !== "string"
    || !POLICY_TEMPLATE_SUBSCRIPTION_READ_NONCE.test(requestNonceInput.toLowerCase())
  ) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription read nonce must be 32 random bytes.",
      "INVALID_READ_NONCE",
    );
  }
  const expiresAt = verifySubscriptionExpiry(expiresAtInput, nowSeconds);
  if (typeof signatureInput !== "string" || !TEMPLATE_SIGNATURE.test(signatureInput)) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature must be a 65-byte wallet signature.",
      "INVALID_SIGNATURE",
    );
  }

  const subscriber = getAddress(subscriberInput);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: policyTemplateSubscriptionReadMessage({
        subscriber,
        requestNonce: requestNonceInput,
        expiresAt,
      }),
      signature: signatureInput as Hex,
    });
  } catch {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature could not be recovered.",
      "INVALID_SIGNATURE",
    );
  }
  if (recovered.toLowerCase() !== subscriber.toLowerCase()) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscriber signature does not match the subscriber wallet.",
      "SIGNER_MISMATCH",
    );
  }
  return {
    subscriber,
    subscriberKey: subscriberKeyForAddress(subscriber),
    signature: signatureInput as Hex,
    expiresAt,
  };
}

/**
 * Read wallet-scoped state only after the caller has proved control of the
 * wallet. Neither underlying table is available to anon/authenticated roles.
 */
export async function getPolicyTemplateSubscriptionSnapshot(
  subscriber: Address,
  subscriberKey: string,
): Promise<PolicyTemplateSubscriptionSnapshot> {
  if (!isSubscriberKey(subscriberKey)) throw new Error("Invalid subscription state key.");
  const response = await fetch(registryUrl(`rpc/${SUBSCRIPTION_SNAPSHOT_RPC}`), {
    method: "POST",
    headers: registryHeaders(),
    body: JSON.stringify({ p_subscriber_key: subscriberKey }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Policy subscription read failed (${response.status}).`);
  }

  const rows = await readBoundedJsonBody(response, MAX_SUBSCRIPTION_SNAPSHOT_BYTES);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error("Policy subscription read returned an invalid snapshot.");
  }
  const row = rows[0] as Record<string, unknown>;
  const version = parseSubscriptionVersion(row.resulting_version);
  const hashes = row.content_hashes;
  if (version === null || !Array.isArray(hashes)) {
    throw new Error("Policy subscription read returned an invalid snapshot.");
  }
  if (hashes.length > 256) {
    throw new Error("Policy subscription read exceeded the per-wallet cap.");
  }

  const contentHashes = hashes.map((contentHash) => {
    if (!isPolicyTemplateHash(contentHash)) {
      throw new Error("Policy subscription read returned an invalid content hash.");
    }
    return contentHash.toLowerCase();
  });
  return {
    subscriber: getAddress(subscriber),
    version,
    contentHashes,
  };
}

/** Stable UUID-shaped pseudonym so one wallet cannot allocate unbounded random subscriber keys. */
export function subscriberKeyForAddress(address: Address): string {
  const digest = keccak256(
    toBytes(`openzaps-policy-template-subscriber/v1:${getAddress(address).toLowerCase()}`),
  ).slice(2, 34);
  const chars = digest.split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const uuid = [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join(""),
  ].join("-");
  if (!isSubscriberKey(uuid)) throw new Error("Subscriber pseudonym derivation failed.");
  return uuid;
}

function parseSubscriptionVersion(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0
    ? Number(parsed)
    : null;
}

function verifySubscriptionExpiry(value: unknown, nowSeconds: number): number {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
    throw new Error("Subscription verifier clock is invalid.");
  }
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization expiry is invalid.",
      "INVALID_EXPIRY",
    );
  }
  const expiresAt = Number(value);
  if (expiresAt <= nowSeconds) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization has expired.",
      "SIGNATURE_EXPIRED",
    );
  }
  if (expiresAt > nowSeconds + POLICY_TEMPLATE_SUBSCRIPTION_TTL_SECONDS) {
    throw new PolicyTemplateSubscriptionAdmissionError(
      "Subscription authorization expiry exceeds the five-minute limit.",
      "EXPIRY_TOO_FAR",
    );
  }
  return expiresAt;
}

function publicTemplateFromRow(row: TemplateRow): PublicPolicyTemplate {
  if (
    !row.publisher_verified
    || !row.visible
    || row.moderation_status !== "approved"
    || typeof row.publisher !== "string"
    || !isAddress(row.publisher)
  ) {
    throw new Error(`Policy template ${row.content_hash} has no verified publisher.`);
  }
  const prepared = preparePolicyTemplate({
    name: row.name,
    summary: row.summary,
    version: row.version,
    parentHash: row.parent_hash,
    chain: row.chain,
  });
  if (prepared.contentHash !== row.content_hash.toLowerCase()) {
    throw new Error(`Policy template ${row.content_hash} failed its content-address check.`);
  }
  if (prepared.schema !== row.schema_version || prepared.compiledHash !== row.compiled_hash) {
    throw new Error(`Policy template ${row.content_hash} failed its compiled metadata check.`);
  }
  return {
    schema: prepared.schema,
    version: prepared.version,
    parentHash: prepared.parentHash,
    name: prepared.name,
    summary: prepared.summary,
    chain: prepared.chain,
    contentHash: prepared.contentHash,
    token: prepared.token,
    compiledHash: prepared.compiledHash,
    publisher: getAddress(row.publisher),
    createdAt: row.created_at,
    subscriptionCount: Math.max(0, Number(row.subscription_count ?? 0)),
  };
}

function validCursorFields(cursor: PolicyTemplateCursor): boolean {
  return typeof cursor.createdAt === "string"
    && cursor.createdAt.length <= 64
    && Number.isFinite(Date.parse(cursor.createdAt))
    && isPolicyTemplateHash(cursor.contentHash);
}

function registryUrl(path: string): string {
  return `${SUPABASE_URL}/rest/v1/${path}`;
}

function registryHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY as string,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}
