import "server-only";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import type { MarketingInteraction } from "@/lib/marketing/types";
import {
  postXReply,
  verifyXReplyTarget,
  type XPublishResult,
  type XVerifiedReplyTarget,
} from "@/lib/marketing/channels/x";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";
import { readBoundedJsonBody } from "@/lib/request-body";

const CREATE_SUBJECT_RPC = "create_marketing_x_reply_subject";
const GET_SUBJECT_RPC = "get_marketing_x_reply_subject";
const CLAIM_SUBJECT_RPC = "claim_marketing_x_reply_subject_admission";
const ADMIT_OUTBOUND_RPC = "admit_marketing_x_outbound_delivery";
const CHECK_OUTBOUND_RPC = "check_marketing_x_outbound_admission";
const FINALIZE_OUTBOUND_RPC = "finalize_marketing_x_outbound_admission";
const INITIALIZE_COMPLIANCE_ACCOUNT_RPC =
  "initialize_marketing_x_compliance_account";
const LIST_COMPLIANCE_RPC = "list_marketing_x_compliance_subjects";
const RECORD_COMPLIANCE_RPC = "record_marketing_x_compliance_checkpoint";
const GET_COMPLIANCE_HEALTH_RPC = "get_marketing_x_compliance_health";
const PURGE_RETENTION_RPC = "purge_marketing_x_retention";

type RpcName =
  | typeof CREATE_SUBJECT_RPC
  | typeof GET_SUBJECT_RPC
  | typeof CLAIM_SUBJECT_RPC
  | typeof ADMIT_OUTBOUND_RPC
  | typeof CHECK_OUTBOUND_RPC
  | typeof FINALIZE_OUTBOUND_RPC
  | typeof INITIALIZE_COMPLIANCE_ACCOUNT_RPC
  | typeof LIST_COMPLIANCE_RPC
  | typeof RECORD_COMPLIANCE_RPC
  | typeof GET_COMPLIANCE_HEALTH_RPC
  | typeof PURGE_RETENTION_RPC;
type Environment = Readonly<Record<string, string | undefined>>;

// A complete 5,000-subject checkpoint inventory is roughly 350 KiB as JSON.
// Keep the RPC cap finite while leaving headroom for maximum-length X ids.
const MAX_RPC_RESPONSE_BYTES = 1_024 * 1_024;
const RPC_TIMEOUT_MS = 12_000;
const X_ID = /^[1-9][0-9]{0,18}$/u;
const OPAQUE_REFERENCE = /^[1-9][0-9]{29}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODE = /^[a-z][a-z0-9_:-]{0,63}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

interface XComplianceDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface RpcConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

export type XComplianceStoreErrorCode =
  | "not_configured"
  | "invalid_input"
  | "network_error"
  | "rpc_error"
  | "invalid_response";

export class XComplianceStoreError extends Error {
  constructor(
    readonly code: XComplianceStoreErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XComplianceStoreError";
  }
}

export interface XReplySubjectReference {
  result:
    | "created"
    | "found"
    | "expired"
    | "not_found"
    | "compliance_hold"
    | "compliance_stale";
  interaction: MarketingInteraction | null;
  expiresAt: string | null;
}

export interface ClaimedXReplySubject {
  result:
    | "claimed"
    | "already_claimed"
    | "expired"
    | "not_found"
    | "compliance_hold"
    | "compliance_stale";
  interactionReference: string;
  claimToken: string | null;
  claimExpiresAt: string | null;
  accountId: string | null;
  postId: string | null;
  authorId: string | null;
  targetUrl: string | null;
  trigger: "mention" | "quote" | null;
  observedAt: string | null;
}

export interface XOutboundAdmission {
  result:
    | "admitted"
    | "already_admitted"
    | "already_consumed"
    | "not_found"
    | "compliance_hold"
    | "compliance_stale"
    | "claim_conflict"
    | "provider_check_stale"
    | "subject_compliance_stale";
  admissionToken: string | null;
  admissionExpiresAt: string | null;
}

export interface XOutboundAdmissionCheck {
  result:
    | "allowed"
    | "completed"
    | "failed"
    | "revoked"
    | "not_found"
    | "lease_expired"
    | "compliance_hold"
    | "compliance_stale";
  allowed: boolean;
  expiresAt: string | null;
}

export interface XOutboundAdmissionFinalization {
  result: "finalized" | "already_finalized" | "not_found";
  state: "completed" | "failed" | "revoked" | null;
  finalizedAt: string | null;
}

export interface XComplianceSubject {
  subjectKind: "account" | "post" | "author";
  subjectId: string;
}

export interface XComplianceSubjectList {
  result: "listed" | "account_not_found" | "limit_exceeded";
  accountId: string;
  subjectCount: number;
  subjects: XComplianceSubject[];
}

export interface XComplianceAccountInitialization {
  result: "created" | "already_exists";
  accountId: string;
  eligibilityCutoffAt: string;
}

export interface XComplianceObservation {
  subjectKind: "account" | "post" | "author";
  subjectId: string;
  outcome:
    | "present"
    | "absent"
    | "deleted"
    | "protected"
    | "suspended"
    | "withheld";
}

export interface XComplianceCheckpoint {
  result:
    | "recorded"
    | "already_recorded"
    | "action_required"
    | "already_actioned"
    | "coverage_conflict";
  checkpointId: string | null;
  checkedAt: string | null;
  validUntil: string | null;
  subjectCount: number;
  nonPresentCount: number;
}

export interface XComplianceHealth {
  result:
    | "healthy"
    | "stale"
    | "hold"
    | "not_initialized"
    | "account_not_found";
  checkpointId: string | null;
  checkedAt: string | null;
  validUntil: string | null;
  subjectCount: number;
  nonPresentCount: number;
  hold: boolean;
}

export interface XRetentionResult {
  result: "purged";
  expiredSubjectCount: number;
  deletedMentionCount: number;
  deletedOptOutCount: number;
  deletedAdmissionCount: number;
  deletedCheckpointCount: number;
  deletedComplianceEventCount: number;
  resetCursorCount: number;
  processedAt: string;
}

function hasSecret(value: string | undefined): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\r\n]/u.test(value);
}

function configuration(env: Environment): RpcConfiguration | null {
  if (env.OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED !== "true") return null;
  if (!hasSecret(env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const rawUrl = env.SUPABASE_URL;
  if (
    !rawUrl
    || !isMarketingLedgerSupabaseUrl(
      rawUrl,
      env.OPENZAPS_MARKETING_SUPABASE_PROJECT_REF,
      env.NODE_ENV !== "production",
    )
  ) return null;

  try {
    const base = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
    return {
      restUrl: new URL("rest/v1/", base).toString(),
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    };
  } catch {
    return null;
  }
}

export function marketingXComplianceConfigured(
  env: Environment = process.env,
): boolean {
  return configuration(env) !== null;
}

function requireConfiguration(env: Environment): RpcConfiguration {
  const configured = configuration(env);
  if (!configured) {
    throw new XComplianceStoreError(
      "not_configured",
      "The durable X compliance store is not configured.",
    );
  }
  return configured;
}

function invalidInput(message: string): never {
  throw new XComplianceStoreError("invalid_input", message);
}

function invalidResponse(): never {
  throw new XComplianceStoreError(
    "invalid_response",
    "The durable X compliance store returned an invalid response.",
  );
}

async function callRpc(
  name: RpcName,
  body: Record<string, unknown>,
  dependencies: XComplianceDependencies,
): Promise<unknown> {
  const configured = requireConfiguration(dependencies.env ?? process.env);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL(`rpc/${name}`, configured.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configured.serviceRoleKey,
          authorization: `Bearer ${configured.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new XComplianceStoreError(
      "network_error",
      "The durable X compliance store could not be reached.",
    );
  }
  if (!response.ok) {
    throw new XComplianceStoreError(
      "rpc_error",
      `The durable X compliance store rejected the request (${response.status}).`,
      response.status,
    );
  }
  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new XComplianceStoreError(
      "invalid_response",
      "The durable X compliance store returned an invalid response.",
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) invalidResponse();
  const row = record(value[0]);
  if (!row) invalidResponse();
  return row;
}

function hasExactKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function nullableString(
  value: unknown,
  pattern: RegExp,
): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function timestamp(value: unknown): string | undefined {
  const parsed = nullableTimestamp(value);
  return parsed === null ? undefined : parsed;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0
    ? Number(parsed)
    : undefined;
}

function assertXId(value: string, label: string): void {
  if (!X_ID.test(value)) invalidInput(`${label} must be an exact X object id.`);
}

function assertOpaqueReference(value: string): void {
  if (!OPAQUE_REFERENCE.test(value)) {
    invalidInput("interactionReference must be an opaque 30-digit reference.");
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) invalidInput(`${label} must be a UUID.`);
}

function parseSafeSubjectRow(
  row: Record<string, unknown>,
  expected: readonly string[],
): XReplySubjectReference {
  if (!hasExactKeys(row, [
    "result_code",
    "interaction_reference",
    "trigger",
    "observed_at",
    "expires_at",
  ])) invalidResponse();
  const result = row.result_code;
  const interactionReference = nullableString(
    row.interaction_reference,
    OPAQUE_REFERENCE,
  );
  const trigger = row.trigger;
  const observedAt = nullableTimestamp(row.observed_at);
  const expiresAt = nullableTimestamp(row.expires_at);
  if (
    !expected.includes(String(result))
    || interactionReference === undefined
    || ![null, "mention", "quote"].includes(trigger as never)
    || observedAt === undefined
    || expiresAt === undefined
  ) invalidResponse();
  const found = result === "created" || result === "found";
  if (
    found
      ? !interactionReference || !trigger || !observedAt || !expiresAt
      : trigger !== null || observedAt !== null
  ) invalidResponse();
  return {
    result: result as XReplySubjectReference["result"],
    interaction: found
      ? {
          id: interactionReference as string,
          trigger: trigger as "mention" | "quote",
          observedAt: observedAt as string,
        }
      : null,
    expiresAt,
  };
}

export async function createMarketingXReplySubject(
  input: XVerifiedReplyTarget,
  dependencies: XComplianceDependencies = {},
): Promise<XReplySubjectReference> {
  assertXId(input.authenticatedAccountId, "authenticatedAccountId");
  assertXId(input.postId, "postId");
  assertXId(input.authorId, "authorId");
  const target = parseCanonicalXStatusUrl(input.targetUrl);
  if (target.postId !== input.postId) invalidInput("targetUrl and postId differ.");
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    invalidInput("observedAt must be a timestamp.");
  }
  const row = oneRow(await callRpc(
    CREATE_SUBJECT_RPC,
    {
      p_account_id: input.authenticatedAccountId,
      p_post_id: input.postId,
      p_author_id: input.authorId,
      p_target_url: target.url,
      p_trigger: input.trigger,
      p_observed_at: new Date(input.observedAt).toISOString(),
    },
    dependencies,
  ));
  const parsed = parseSafeSubjectRow(row, [
    "created",
    "not_found",
    "compliance_hold",
    "compliance_stale",
  ]);
  if (
    parsed.result !== "created"
    && (
      row.interaction_reference !== null
      || row.expires_at !== null
    )
  ) invalidResponse();
  return parsed;
}

export async function getMarketingXReplySubject(
  interactionReference: string,
  dependencies: XComplianceDependencies = {},
): Promise<XReplySubjectReference> {
  assertOpaqueReference(interactionReference);
  const row = oneRow(await callRpc(
    GET_SUBJECT_RPC,
    { p_interaction_reference: interactionReference },
    dependencies,
  ));
  const parsed = parseSafeSubjectRow(row, [
    "found",
    "expired",
    "not_found",
    "compliance_hold",
    "compliance_stale",
  ]);
  if (
    parsed.interaction
      ? parsed.interaction.id !== interactionReference
      : row.interaction_reference !== interactionReference
        && row.interaction_reference !== null
  ) invalidResponse();
  if (
    parsed.result === "not_found"
      ? row.interaction_reference !== interactionReference
        || parsed.expiresAt !== null
      : parsed.result !== "found"
        && (row.interaction_reference !== interactionReference || !parsed.expiresAt)
  ) invalidResponse();
  return parsed;
}

export async function claimMarketingXReplySubject(
  input: { interactionReference: string; idempotencyKey: string },
  dependencies: XComplianceDependencies = {},
): Promise<ClaimedXReplySubject> {
  assertOpaqueReference(input.interactionReference);
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    invalidInput("idempotencyKey is invalid.");
  }
  const row = oneRow(await callRpc(
    CLAIM_SUBJECT_RPC,
    {
      p_interaction_reference: input.interactionReference,
      p_idempotency_key: input.idempotencyKey,
    },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "interaction_reference",
    "claim_token",
    "claim_expires_at",
    "account_id",
    "post_id",
    "author_id",
    "target_url",
    "trigger",
    "observed_at",
  ])) invalidResponse();
  const result = row.result_code;
  const reference = nullableString(row.interaction_reference, OPAQUE_REFERENCE);
  const claimToken = nullableString(row.claim_token, UUID);
  const claimExpiresAt = nullableTimestamp(row.claim_expires_at);
  const accountId = nullableString(row.account_id, X_ID);
  const postId = nullableString(row.post_id, X_ID);
  const authorId = nullableString(row.author_id, X_ID);
  const targetUrl = row.target_url === null
    ? null
    : typeof row.target_url === "string"
      ? (() => {
          try {
            return parseCanonicalXStatusUrl(row.target_url).url;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const trigger = row.trigger;
  const observedAt = nullableTimestamp(row.observed_at);
  if (
    ![
      "claimed",
      "already_claimed",
      "expired",
      "not_found",
      "compliance_hold",
      "compliance_stale",
    ].includes(String(result))
    || reference !== input.interactionReference
    || claimToken === undefined
    || claimExpiresAt === undefined
    || accountId === undefined
    || postId === undefined
    || authorId === undefined
    || targetUrl === undefined
    || ![null, "mention", "quote"].includes(trigger as never)
    || observedAt === undefined
  ) invalidResponse();
  const claimed = result === "claimed";
  if (
    claimed
      ? !claimToken || !claimExpiresAt || !accountId || !postId || !authorId
        || !targetUrl || !trigger || !observedAt
      : claimToken !== null || claimExpiresAt !== null || accountId !== null
        || postId !== null || authorId !== null || targetUrl !== null
        || trigger !== null || observedAt !== null
  ) invalidResponse();
  return {
    result: result as ClaimedXReplySubject["result"],
    interactionReference: input.interactionReference,
    claimToken,
    claimExpiresAt,
    accountId,
    postId,
    authorId,
    targetUrl,
    trigger: trigger as ClaimedXReplySubject["trigger"],
    observedAt,
  };
}

export async function admitMarketingXOutboundDelivery(
  input: {
    accountId: string;
    interactionReference: string;
    postId: string;
    authorId: string;
    sourceClaimToken: string;
    providerCheckedAt: string;
  },
  dependencies: XComplianceDependencies = {},
): Promise<XOutboundAdmission> {
  assertXId(input.accountId, "accountId");
  assertOpaqueReference(input.interactionReference);
  assertXId(input.postId, "postId");
  assertXId(input.authorId, "authorId");
  assertUuid(input.sourceClaimToken, "sourceClaimToken");
  if (!Number.isFinite(Date.parse(input.providerCheckedAt))) {
    invalidInput("providerCheckedAt must be a timestamp.");
  }
  const row = oneRow(await callRpc(
    ADMIT_OUTBOUND_RPC,
    {
      p_account_id: input.accountId,
      p_interaction_reference: input.interactionReference,
      p_post_id: input.postId,
      p_author_id: input.authorId,
      p_source_claim_token: input.sourceClaimToken.toLowerCase(),
      p_provider_checked_at: new Date(input.providerCheckedAt).toISOString(),
    },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "admission_token",
    "admission_expires_at",
  ])) invalidResponse();
  const result = row.result_code;
  const admissionToken = nullableString(row.admission_token, UUID);
  const admissionExpiresAt = nullableTimestamp(row.admission_expires_at);
  if (
    ![
      "admitted",
      "already_admitted",
      "already_consumed",
      "not_found",
      "compliance_hold",
      "compliance_stale",
      "claim_conflict",
      "provider_check_stale",
      "subject_compliance_stale",
    ].includes(String(result))
    || admissionToken === undefined
    || admissionExpiresAt === undefined
    || (["admitted", "already_admitted", "already_consumed"].includes(
      String(result),
    )
      ? !admissionToken || !admissionExpiresAt
      : admissionToken !== null || admissionExpiresAt !== null)
  ) invalidResponse();
  return {
    result: result as XOutboundAdmission["result"],
    admissionToken,
    admissionExpiresAt,
  };
}

export async function checkMarketingXOutboundAdmission(
  admissionToken: string,
  dependencies: XComplianceDependencies = {},
): Promise<XOutboundAdmissionCheck> {
  assertUuid(admissionToken, "admissionToken");
  const row = oneRow(await callRpc(
    CHECK_OUTBOUND_RPC,
    { p_admission_token: admissionToken.toLowerCase() },
    dependencies,
  ));
  if (!hasExactKeys(row, ["result_code", "allowed", "expires_at"])) {
    invalidResponse();
  }
  const result = row.result_code;
  const allowed = row.allowed;
  const expiresAt = nullableTimestamp(row.expires_at);
  if (
    ![
      "allowed",
      "completed",
      "failed",
      "revoked",
      "not_found",
      "lease_expired",
      "compliance_hold",
      "compliance_stale",
    ].includes(String(result))
    || typeof allowed !== "boolean"
    || expiresAt === undefined
    || (result === "allowed"
      ? !allowed || !expiresAt
      : allowed || (result === "not_found" ? expiresAt !== null : !expiresAt))
  ) invalidResponse();
  return {
    result: result as XOutboundAdmissionCheck["result"],
    allowed,
    expiresAt,
  };
}

export async function finalizeMarketingXOutboundAdmission(
  input: {
    admissionToken: string;
    outcome: "completed" | "failed";
    failureCode?: string | null;
  },
  dependencies: XComplianceDependencies = {},
): Promise<XOutboundAdmissionFinalization> {
  assertUuid(input.admissionToken, "admissionToken");
  const failureCode = input.failureCode ?? null;
  if (
    (input.outcome === "completed" && failureCode !== null)
    || (input.outcome === "failed" && (!failureCode || !CODE.test(failureCode)))
  ) invalidInput("failureCode must exactly match the terminal outcome.");
  const row = oneRow(await callRpc(
    FINALIZE_OUTBOUND_RPC,
    {
      p_admission_token: input.admissionToken.toLowerCase(),
      p_outcome: input.outcome,
      p_failure_code: failureCode,
    },
    dependencies,
  ));
  if (!hasExactKeys(row, ["result_code", "state", "finalized_at"])) {
    invalidResponse();
  }
  const result = row.result_code;
  const state = row.state;
  const finalizedAt = nullableTimestamp(row.finalized_at);
  if (
    !["finalized", "already_finalized", "not_found"].includes(
      String(result),
    )
    || ![null, "completed", "failed", "revoked"].includes(state as never)
    || finalizedAt === undefined
    || (result === "finalized"
      ? state !== input.outcome || !finalizedAt
      : result === "already_finalized"
        ? state === null || !finalizedAt
        : state !== null || finalizedAt !== null)
  ) invalidResponse();
  return {
    result: result as XOutboundAdmissionFinalization["result"],
    state: state as XOutboundAdmissionFinalization["state"],
    finalizedAt,
  };
}

export async function listMarketingXComplianceSubjects(
  accountId: string,
  limit = 5_000,
  dependencies: XComplianceDependencies = {},
): Promise<XComplianceSubjectList> {
  assertXId(accountId, "accountId");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    invalidInput("limit must be from 1 to 5000.");
  }
  const row = oneRow(await callRpc(
    LIST_COMPLIANCE_RPC,
    { p_account_id: accountId, p_limit: limit },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "account_id",
    "subject_count",
    "subjects",
  ])) invalidResponse();
  const result = row.result_code;
  const returnedAccountId = nullableString(row.account_id, X_ID);
  const subjectCount = nonnegativeInteger(row.subject_count);
  const subjectsRaw = row.subjects;
  if (
    !["listed", "account_not_found", "limit_exceeded"].includes(String(result))
    || returnedAccountId !== accountId
    || subjectCount === undefined
    || !Array.isArray(subjectsRaw)
  ) invalidResponse();
  const seen = new Set<string>();
  const subjects = subjectsRaw.map((value) => {
    const subject = record(value);
    const subjectKind = subject?.subject_kind;
    const subjectId = subject?.subject_id;
    if (
      !subject
      || !hasExactKeys(subject, ["subject_kind", "subject_id"])
      || !["account", "post", "author"].includes(String(subjectKind))
      || typeof subjectId !== "string"
      || !X_ID.test(subjectId)
    ) invalidResponse();
    const key = `${subjectKind}:${subjectId}`;
    if (seen.has(key)) invalidResponse();
    seen.add(key);
    return {
      subjectKind: subjectKind as XComplianceSubject["subjectKind"],
      subjectId,
    };
  });
  if (
    result === "listed"
      ? subjectCount !== subjects.length || subjectCount > limit
        || subjects.filter(
          (subject) => subject.subjectKind === "account"
            && subject.subjectId === accountId,
        ).length !== 1
        || subjects.some(
          (subject) => subject.subjectKind === "account"
            && subject.subjectId !== accountId,
        )
      : subjects.length !== 0
        || (result === "account_not_found"
          ? subjectCount !== 0
          : subjectCount <= limit)
  ) invalidResponse();
  return {
    result: result as XComplianceSubjectList["result"],
    accountId,
    subjectCount,
    subjects,
  };
}

export async function initializeMarketingXComplianceAccount(
  input: { accountId: string; verifiedAt: string },
  dependencies: XComplianceDependencies = {},
): Promise<XComplianceAccountInitialization> {
  assertXId(input.accountId, "accountId");
  if (!Number.isFinite(Date.parse(input.verifiedAt))) {
    invalidInput("verifiedAt must be a timestamp.");
  }
  const row = oneRow(await callRpc(
    INITIALIZE_COMPLIANCE_ACCOUNT_RPC,
    {
      p_account_id: input.accountId,
      p_verified_at: new Date(input.verifiedAt).toISOString(),
    },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "account_id",
    "eligibility_cutoff_at",
  ])) invalidResponse();
  const result = row.result_code;
  const accountId = nullableString(row.account_id, X_ID);
  const eligibilityCutoffAt = timestamp(row.eligibility_cutoff_at);
  if (
    !["created", "already_exists"].includes(String(result))
    || accountId !== input.accountId
    || !eligibilityCutoffAt
  ) invalidResponse();
  return {
    result: result as XComplianceAccountInitialization["result"],
    accountId,
    eligibilityCutoffAt,
  };
}

export async function recordMarketingXComplianceCheckpoint(
  input: {
    accountId: string;
    providerRunId: string;
    startedAt: string;
    completedAt: string;
    observations: readonly XComplianceObservation[];
  },
  dependencies: XComplianceDependencies = {},
): Promise<XComplianceCheckpoint> {
  assertXId(input.accountId, "accountId");
  assertUuid(input.providerRunId, "providerRunId");
  const startedAt = Date.parse(input.startedAt);
  const completedAt = Date.parse(input.completedAt);
  if (
    !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt
    || input.observations.length < 1
    || input.observations.length > 5_000
  ) invalidInput("The compliance observation window is invalid.");
  const seen = new Set<string>();
  const observations = input.observations.map((observation) => {
    if (
      !["account", "post", "author"].includes(observation.subjectKind)
      || !X_ID.test(observation.subjectId)
      || ![
        "present",
        "absent",
        "deleted",
        "protected",
        "suspended",
        "withheld",
      ].includes(
        observation.outcome,
      )
      || (observation.subjectKind === "account"
        && observation.subjectId !== input.accountId)
    ) invalidInput("A compliance observation is invalid.");
    const key = `${observation.subjectKind}:${observation.subjectId}`;
    if (seen.has(key)) invalidInput("Compliance observations must be unique.");
    seen.add(key);
    return {
      subject_kind: observation.subjectKind,
      subject_id: observation.subjectId,
      outcome: observation.outcome,
    };
  });
  const row = oneRow(await callRpc(
    RECORD_COMPLIANCE_RPC,
    {
      p_account_id: input.accountId,
      p_provider_run_id: input.providerRunId.toLowerCase(),
      p_started_at: new Date(startedAt).toISOString(),
      p_completed_at: new Date(completedAt).toISOString(),
      p_observations: observations,
    },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "checkpoint_id",
    "checked_at",
    "valid_until",
    "subject_count",
    "non_present_count",
  ])) invalidResponse();
  const result = row.result_code;
  const checkpointId = nullableString(row.checkpoint_id, UUID);
  const checkedAt = nullableTimestamp(row.checked_at);
  const validUntil = nullableTimestamp(row.valid_until);
  const subjectCount = nonnegativeInteger(row.subject_count);
  const nonPresentCount = nonnegativeInteger(row.non_present_count);
  if (
    ![
      "recorded",
      "already_recorded",
      "action_required",
      "already_actioned",
      "coverage_conflict",
    ].includes(String(result))
    || checkpointId === undefined
    || checkedAt === undefined
    || validUntil === undefined
    || subjectCount === undefined
    || nonPresentCount === undefined
    || subjectCount !== observations.length
    || (result === "coverage_conflict"
      ? checkpointId !== null || checkedAt !== null || validUntil !== null
        || nonPresentCount !== 0
      : !checkpointId || !checkedAt || !validUntil
        || (["recorded", "already_recorded"].includes(String(result))
          ? nonPresentCount !== 0
          : nonPresentCount < 1))
  ) invalidResponse();
  return {
    result: result as XComplianceCheckpoint["result"],
    checkpointId,
    checkedAt,
    validUntil,
    subjectCount,
    nonPresentCount,
  };
}

export async function getMarketingXComplianceHealth(
  accountId: string,
  dependencies: XComplianceDependencies = {},
): Promise<XComplianceHealth> {
  assertXId(accountId, "accountId");
  const row = oneRow(await callRpc(
    GET_COMPLIANCE_HEALTH_RPC,
    { p_account_id: accountId },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "checkpoint_id",
    "checked_at",
    "valid_until",
    "subject_count",
    "non_present_count",
    "hold",
  ])) invalidResponse();
  const result = row.result_code;
  const checkpointId = nullableString(row.checkpoint_id, UUID);
  const checkedAt = nullableTimestamp(row.checked_at);
  const validUntil = nullableTimestamp(row.valid_until);
  const subjectCount = nonnegativeInteger(row.subject_count);
  const nonPresentCount = nonnegativeInteger(row.non_present_count);
  const hold = row.hold;
  if (
    ![
      "healthy",
      "stale",
      "hold",
      "not_initialized",
      "account_not_found",
    ].includes(String(result))
    || checkpointId === undefined
    || checkedAt === undefined
    || validUntil === undefined
    || subjectCount === undefined
    || nonPresentCount === undefined
    || typeof hold !== "boolean"
    || (result === "account_not_found"
      ? checkpointId !== null || checkedAt !== null || validUntil !== null
        || subjectCount !== 0 || nonPresentCount !== 0 || hold
      : result === "healthy"
        ? !checkpointId || !checkedAt || !validUntil || hold
          || subjectCount < 1 || nonPresentCount !== 0
        : result === "hold"
          ? !hold
          : hold)
    || ((checkpointId === null) !== (checkedAt === null))
    || ((checkpointId === null) !== (validUntil === null))
  ) invalidResponse();
  return {
    result: result as XComplianceHealth["result"],
    checkpointId,
    checkedAt,
    validUntil,
    subjectCount,
    nonPresentCount,
    hold,
  };
}

export async function purgeMarketingXRetention(
  now = new Date().toISOString(),
  dependencies: XComplianceDependencies = {},
): Promise<XRetentionResult> {
  if (!Number.isFinite(Date.parse(now))) invalidInput("now must be a timestamp.");
  const row = oneRow(await callRpc(
    PURGE_RETENTION_RPC,
    { p_now: new Date(now).toISOString() },
    dependencies,
  ));
  if (!hasExactKeys(row, [
    "result_code",
    "expired_subject_count",
    "deleted_mention_count",
    "deleted_opt_out_count",
    "deleted_admission_count",
    "deleted_checkpoint_count",
    "deleted_compliance_event_count",
    "reset_cursor_count",
    "processed_at",
  ])) invalidResponse();
  const counts = {
    expiredSubjectCount: nonnegativeInteger(row.expired_subject_count),
    deletedMentionCount: nonnegativeInteger(row.deleted_mention_count),
    deletedOptOutCount: nonnegativeInteger(row.deleted_opt_out_count),
    deletedAdmissionCount: nonnegativeInteger(row.deleted_admission_count),
    deletedCheckpointCount: nonnegativeInteger(row.deleted_checkpoint_count),
    deletedComplianceEventCount: nonnegativeInteger(
      row.deleted_compliance_event_count,
    ),
    resetCursorCount: nonnegativeInteger(row.reset_cursor_count),
  };
  const processedAt = timestamp(row.processed_at);
  if (
    row.result_code !== "purged"
    || Object.values(counts).some((value) => value === undefined)
    || !processedAt
  ) invalidResponse();
  return {
    result: "purged",
    expiredSubjectCount: counts.expiredSubjectCount as number,
    deletedMentionCount: counts.deletedMentionCount as number,
    deletedOptOutCount: counts.deletedOptOutCount as number,
    deletedAdmissionCount: counts.deletedAdmissionCount as number,
    deletedCheckpointCount: counts.deletedCheckpointCount as number,
    deletedComplianceEventCount: counts.deletedComplianceEventCount as number,
    resetCursorCount: counts.resetCursorCount as number,
    processedAt,
  };
}

/**
 * Resolve, reverify, admit, and publish a manual reply inside one server step.
 * Raw provider subject metadata never leaves this function or enters Workflow.
 */
export async function postMarketingXReplyFromSubject(
  input: {
    interactionReference: string;
    text: string;
    idempotencyKey: string;
  },
  dependencies: XComplianceDependencies & {
    channel?: Parameters<typeof verifyXReplyTarget>[1];
  } = {},
): Promise<XPublishResult> {
  const claimed = await claimMarketingXReplySubject(
    {
      interactionReference: input.interactionReference,
      idempotencyKey: input.idempotencyKey,
    },
    dependencies,
  );
  if (
    claimed.result !== "claimed"
    || !claimed.claimToken
    || !claimed.accountId
    || !claimed.postId
    || !claimed.authorId
    || !claimed.targetUrl
    || !claimed.trigger
  ) {
    throw new XComplianceStoreError(
      "rpc_error",
      `The X reply subject was not admitted (${claimed.result}).`,
    );
  }

  const verified = await verifyXReplyTarget(
    claimed.targetUrl,
    dependencies.channel,
  );
  if (
    verified.postId !== claimed.postId
    || verified.authorId !== claimed.authorId
    || verified.authenticatedAccountId !== claimed.accountId
    || verified.targetUrl !== claimed.targetUrl
    || verified.trigger !== claimed.trigger
  ) {
    throw new XComplianceStoreError(
      "invalid_response",
      "The X reply subject changed after approval.",
    );
  }

  const admission = await admitMarketingXOutboundDelivery(
    {
      accountId: claimed.accountId,
      interactionReference: claimed.interactionReference,
      postId: claimed.postId,
      authorId: claimed.authorId,
      sourceClaimToken: claimed.claimToken,
      providerCheckedAt: verified.observedAt,
    },
    dependencies,
  );
  if (admission.result !== "admitted" || !admission.admissionToken) {
    throw new XComplianceStoreError(
      "rpc_error",
      `The final X outbound fence denied delivery (${admission.result}).`,
    );
  }

  const checked = await checkMarketingXOutboundAdmission(
    admission.admissionToken,
    dependencies,
  );
  if (!checked.allowed || checked.result !== "allowed") {
    await finalizeMarketingXOutboundAdmission(
      {
        admissionToken: admission.admissionToken,
        outcome: "failed",
        failureCode: "admission_revoked",
      },
      dependencies,
    ).catch(() => undefined);
    throw new XComplianceStoreError(
      "rpc_error",
      "The final X outbound fence was revoked before delivery.",
    );
  }

  let receipt: XPublishResult;
  try {
    receipt = await postXReply(
      {
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        inReplyToTweetId: claimed.postId,
        authenticatedAccountId: claimed.accountId,
      },
      dependencies.channel,
    );
  } catch (error) {
    await finalizeMarketingXOutboundAdmission(
      {
        admissionToken: admission.admissionToken,
        outcome: "failed",
        failureCode: "provider_write_failed",
      },
      dependencies,
    ).catch(() => undefined);
    throw error;
  }

  const finalized = await finalizeMarketingXOutboundAdmission(
    {
      admissionToken: admission.admissionToken,
      outcome: "completed",
    },
    dependencies,
  );
  if (![
    "finalized",
    "already_finalized",
  ].includes(finalized.result) || finalized.state !== "completed") {
    throw new XComplianceStoreError(
      "invalid_response",
      "X accepted the reply but the compliance admission could not be finalized.",
    );
  }
  return receipt;
}
