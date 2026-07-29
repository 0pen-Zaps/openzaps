import {
  getAddress,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";

import {
  isPolicyTemplateHash,
  policyTemplatePublishMessage,
  preparePolicyTemplate,
  type PreparedPolicyTemplate,
  type PublicPolicyTemplate,
} from "@/lib/policy-templates";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEMPLATE_TABLE = "policy_templates";
const SUBSCRIPTION_TABLE = "policy_template_subscriptions";
const TEMPLATE_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAX_PAGE_SIZE = 50;

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
  } = process.env,
): boolean {
  return env.NODE_ENV !== "production"
    || env.OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED === "true";
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
): Promise<void> {
  if (!isSubscriberKey(subscriberKey) || !isPolicyTemplateHash(contentHash)) throw new Error("Invalid subscription.");
  const path = `${SUBSCRIPTION_TABLE}?subscriber_key=eq.${subscriberKey}&content_hash=eq.${contentHash.toLowerCase()}`;
  const response = subscribed
    ? await fetch(registryUrl(`${SUBSCRIPTION_TABLE}?on_conflict=subscriber_key,content_hash`), {
        method: "POST",
        headers: registryHeaders({ prefer: "return=minimal,resolution=ignore-duplicates" }),
        body: JSON.stringify({ subscriber_key: subscriberKey, content_hash: contentHash.toLowerCase() }),
      })
    : await fetch(registryUrl(path), {
        method: "DELETE",
        headers: registryHeaders({ prefer: "return=minimal" }),
      });
  if (!response.ok) throw new Error(`Policy subscription write failed (${response.status}).`);
}

export function isSubscriberKey(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
