import "server-only";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import { readBoundedJsonBody } from "@/lib/request-body";

const CLAIM_POLL_RPC = "claim_marketing_x_mention_poll";
const COMMIT_DISCOVERY_RPC = "commit_marketing_x_mention_discovery";
const CLAIM_REPLY_RPC = "claim_next_marketing_x_mention";
const GET_INTERACTION_REFERENCE_RPC = "get_marketing_x_interaction_reference";
const DEFER_POLL_RPC = "defer_marketing_x_mention_poll";
const LIST_INBOX_RPC = "list_marketing_x_mention_inbox";
const COMPLETE_REPLY_RPC = "complete_marketing_x_mention_reply";
const FAIL_REPLY_RPC = "fail_marketing_x_mention_reply";
const OPT_OUT_RPC = "record_marketing_x_mention_opt_out";

const MAX_RPC_RESPONSE_BYTES = 128 * 1_024;
const RPC_TIMEOUT_MS = 12_000;
const MAX_DISCOVERY_ITEMS = 500;
const X_ID = /^[1-9][0-9]{0,18}$/u;
const CONTENT_HMAC = /^[0-9a-f]{64}$/u;
const CODE = /^[a-z][a-z0-9_:-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const OPAQUE_INTERACTION = /^[1-9][0-9]{29}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

interface XMentionDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface RpcConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

export type XMentionClassification =
  | "auto_reply"
  | "review"
  | "ignore"
  | "opt_out";

export interface XMentionDiscoveryItem {
  postId: string;
  authorId: string;
  conversationId: string;
  createdAt: string;
  contentHmac: string;
  classification: XMentionClassification;
  eligibilityReason: string;
}

interface XMentionPollLeaseBase {
  accountId: string;
  sinceId: string | null;
  continuationUntilId: string | null;
  continuationBaseSinceId: string | null;
  continuationNewestId: string | null;
  baselineRequired: boolean;
  nextPollAt: string;
  lastSuccessAt: string | null;
}

export type XMentionPollLease = XMentionPollLeaseBase & (
  | {
    result: "claimed";
    leaseToken: string;
    leaseExpiresAt: string;
  }
  | {
    result: "leased";
    leaseToken: null;
    leaseExpiresAt: string;
  }
  | {
    result: "not_due";
    leaseToken: null;
    leaseExpiresAt: null;
  }
  | {
    result: "compliance_hold";
    leaseToken: null;
    leaseExpiresAt: null;
  }
);

export interface DeferXMentionPollInput {
  accountId: string;
  leaseToken: string;
  nextPollAt: string;
  reason: string;
}

export interface XMentionPollDeferral {
  result: "deferred" | "lease_lost";
  accountId: string;
  nextPollAt: string | null;
  lastSuccessAt: string | null;
  reason: string | null;
  deferredAt: string | null;
}

export interface CommitXMentionDiscoveryInput {
  accountId: string;
  leaseToken: string;
  previousSinceId: string | null;
  nextSinceId: string | null;
  previousContinuationUntilId: string | null;
  nextContinuationUntilId: string | null;
  completed: boolean;
  mentions: readonly XMentionDiscoveryItem[];
}

export interface XMentionDiscoveryCommit {
  result:
    | "committed"
    | "baseline_empty"
    | "partial_committed"
    | "lease_lost"
    | "cursor_conflict";
  accountId: string;
  insertedCount: number;
  existingCount: number;
  optOutCount: number;
  sinceId: string | null;
  continuationUntilId: string | null;
  continuationNewestId: string | null;
  initializedAt: string | null;
  nextPollAt: string | null;
  lastSuccessAt: string | null;
}

export interface ClaimedXMention {
  accountId: string;
  postId: string;
  authorId: string;
  conversationId: string;
  createdAt: string;
  contentHmac: string;
  deliveryReference: string;
  interactionReference: string;
  classification: "auto_reply";
  eligibilityReason: string;
  claimToken: string;
  claimDay: string;
  claimedAt: string;
}

export interface XMentionReplyClaim {
  result:
    | "claimed"
    | "no_eligible"
    | "not_initialized"
    | "poll_incomplete"
    | "daily_cap_reached";
  mention: ClaimedXMention | null;
  claimDay: string | null;
}

export interface XMentionInteractionReference {
  result: "found" | "not_found";
  accountId: string;
  postId: string;
  interactionReference: string | null;
}

export type XMentionInboxState =
  | "eligible"
  | "review_required"
  | "ignored"
  | "opted_out"
  | "claimed"
  | "replied"
  | "failed";

export interface XMentionInboxItem {
  postId: string;
  authorId: string;
  conversationId: string;
  createdAt: string;
  contentHmac: string;
  classification: XMentionClassification;
  eligibilityReason: string;
  state: XMentionInboxState;
  discoveredAt: string;
  stateChangedAt: string;
  claimDay: string | null;
  claimedAt: string | null;
  repliedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
}

export interface ListXMentionInboxInput {
  accountId: string;
  limit?: number;
}

export interface XMentionInboxResult {
  result: "listed" | "account_not_found";
  accountId: string;
  reviewRequiredCount: number;
  items: XMentionInboxItem[];
}

export interface XMentionReplyMutationInput {
  accountId: string;
  postId: string;
  claimToken: string;
}

export interface FailXMentionReplyInput extends XMentionReplyMutationInput {
  failureCode: string;
}

export interface XMentionReplyMutation {
  result:
    | "completed"
    | "failed"
    | "already_completed"
    | "already_failed"
    | "claim_conflict"
    | "not_claimed"
    | "not_found";
  accountId: string;
  postId: string;
  state: "claimed" | "replied" | "failed" | null;
  finishedAt: string | null;
}

export interface RecordXMentionOptOutInput {
  accountId: string;
  authorId: string;
  sourcePostId?: string | null;
}

export interface XMentionOptOutMutation {
  result: "recorded" | "already_recorded" | "account_not_found";
  accountId: string;
  authorId: string;
  sourcePostId: string | null;
  optedOutAt: string | null;
  blockedCount: number;
}

export type XMentionStoreErrorCode =
  | "not_configured"
  | "invalid_input"
  | "network_error"
  | "rpc_error"
  | "invalid_response";

export class XMentionStoreError extends Error {
  constructor(
    readonly code: XMentionStoreErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XMentionStoreError";
  }
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

export function marketingXMentionsConfigured(
  env: Environment = process.env,
): boolean {
  return configuration(env) !== null;
}

function requireConfiguration(env: Environment): RpcConfiguration {
  const configured = configuration(env);
  if (!configured) {
    throw new XMentionStoreError(
      "not_configured",
      "The durable X mention inbox is not configured.",
    );
  }
  return configured;
}

async function callRpc(
  name:
    | typeof CLAIM_POLL_RPC
    | typeof COMMIT_DISCOVERY_RPC
    | typeof DEFER_POLL_RPC
    | typeof LIST_INBOX_RPC
    | typeof CLAIM_REPLY_RPC
    | typeof GET_INTERACTION_REFERENCE_RPC
    | typeof COMPLETE_REPLY_RPC
    | typeof FAIL_REPLY_RPC
    | typeof OPT_OUT_RPC,
  body: Record<string, unknown>,
  dependencies: XMentionDependencies,
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
    throw new XMentionStoreError(
      "network_error",
      "The durable X mention inbox could not be reached.",
    );
  }

  if (!response.ok) {
    throw new XMentionStoreError(
      "rpc_error",
      `The durable X mention inbox rejected the request (${response.status}).`,
      response.status,
    );
  }

  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new XMentionStoreError(
      "invalid_response",
      "The durable X mention inbox returned an invalid response.",
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

function invalidInput(message: string): never {
  throw new XMentionStoreError("invalid_input", message);
}

function invalidResponse(): never {
  throw new XMentionStoreError(
    "invalid_response",
    "The durable X mention inbox returned an invalid response.",
  );
}

function nullableXId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && X_ID.test(value) ? value : undefined;
}

function xId(value: unknown): string | undefined {
  return typeof value === "string" && X_ID.test(value) ? value : undefined;
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

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function assertXId(value: string, label: string): void {
  if (!X_ID.test(value)) invalidInput(`${label} must be an exact X object id.`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) invalidInput(`${label} must be a UUID.`);
}

function normalizeDiscoveryItems(
  mentions: readonly XMentionDiscoveryItem[],
): Array<Record<string, string>> {
  if (!Array.isArray(mentions) || mentions.length > MAX_DISCOVERY_ITEMS) {
    invalidInput(`X mention discovery accepts at most ${MAX_DISCOVERY_ITEMS} items.`);
  }

  const seen = new Set<string>();
  return mentions.map((mention) => {
    if (!mention || typeof mention !== "object") {
      invalidInput("Every X mention discovery item must be an object.");
    }
    assertXId(mention.postId, "postId");
    assertXId(mention.authorId, "authorId");
    assertXId(mention.conversationId, "conversationId");
    if (seen.has(mention.postId)) {
      invalidInput("X mention discovery post IDs must be unique.");
    }
    seen.add(mention.postId);
    if (!CONTENT_HMAC.test(mention.contentHmac)) {
      invalidInput("contentHmac must be a lowercase 64-character hex HMAC.");
    }
    if (!["auto_reply", "review", "ignore", "opt_out"].includes(
      mention.classification,
    )) {
      invalidInput("X mention classification is invalid.");
    }
    if (!CODE.test(mention.eligibilityReason)) {
      invalidInput("eligibilityReason must be a bounded machine-readable code.");
    }
    const parsed = Date.parse(mention.createdAt);
    if (!Number.isFinite(parsed)) invalidInput("createdAt must be a timestamp.");

    return {
      post_id: mention.postId,
      author_id: mention.authorId,
      conversation_id: mention.conversationId,
      created_at: new Date(parsed).toISOString(),
      content_hmac: mention.contentHmac,
      classification: mention.classification,
      eligibility_reason: mention.eligibilityReason,
    };
  });
}

export async function claimXMentionPollLease(
  accountId: string,
  dependencies: XMentionDependencies = {},
): Promise<XMentionPollLease> {
  assertXId(accountId, "accountId");
  const row = oneRow(await callRpc(
    CLAIM_POLL_RPC,
    { p_account_id: accountId },
    dependencies,
  ));

  const result = row.result_code;
  const returnedAccountId = xId(row.account_id);
  const leaseToken = row.lease_token === null ? null : uuid(row.lease_token);
  const sinceId = nullableXId(row.since_id);
  const continuationUntilId = nullableXId(row.continuation_until_id);
  const continuationBaseSinceId = nullableXId(row.continuation_base_since_id);
  const continuationNewestId = nullableXId(row.continuation_newest_id);
  const baselineRequired = row.baseline_required;
  const leaseExpiresAt = nullableTimestamp(row.lease_expires_at);
  const nextPollAt = timestamp(row.next_poll_at);
  const lastSuccessAt = nullableTimestamp(row.last_success_at);

  if (
    !["claimed", "leased", "not_due", "compliance_hold"].includes(String(result))
    || returnedAccountId !== accountId
    || sinceId === undefined
    || continuationUntilId === undefined
    || continuationBaseSinceId === undefined
    || continuationNewestId === undefined
    || typeof baselineRequired !== "boolean"
    || leaseExpiresAt === undefined
    || !nextPollAt
    || lastSuccessAt === undefined
    || (result === "claimed" && (!leaseToken || !leaseExpiresAt))
    || (result !== "claimed" && leaseToken !== null)
    || (result === "leased" && !leaseExpiresAt)
    || (["not_due", "compliance_hold"].includes(String(result))
      && leaseExpiresAt !== null)
    || (
      continuationUntilId === null
      && (
        continuationBaseSinceId !== null
        || continuationNewestId !== null
      )
    )
    || (
      continuationUntilId !== null
      && (
        continuationNewestId === null
        || continuationBaseSinceId !== sinceId
      )
    )
  ) invalidResponse();

  const common: XMentionPollLeaseBase = {
    accountId,
    sinceId,
    continuationUntilId,
    continuationBaseSinceId,
    continuationNewestId,
    baselineRequired,
    nextPollAt,
    lastSuccessAt,
  };
  if (result === "claimed") {
    return {
      ...common,
      result,
      leaseToken: leaseToken as string,
      leaseExpiresAt: leaseExpiresAt as string,
    };
  }
  if (result === "leased") {
    return {
      ...common,
      result,
      leaseToken: null,
      leaseExpiresAt: leaseExpiresAt as string,
    };
  }
  return {
    ...common,
    result: result as "not_due" | "compliance_hold",
    leaseToken: null,
    leaseExpiresAt: null,
  };
}

export async function deferXMentionPoll(
  input: DeferXMentionPollInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionPollDeferral> {
  assertXId(input.accountId, "accountId");
  assertUuid(input.leaseToken, "leaseToken");
  if (!CODE.test(input.reason)) {
    invalidInput("reason must be a bounded machine-readable code.");
  }
  const parsedNextPollAt = Date.parse(input.nextPollAt);
  if (!Number.isFinite(parsedNextPollAt)) {
    invalidInput("nextPollAt must be a timestamp.");
  }

  const row = oneRow(await callRpc(
    DEFER_POLL_RPC,
    {
      p_account_id: input.accountId,
      p_lease_token: input.leaseToken.toLowerCase(),
      p_next_poll_at: new Date(parsedNextPollAt).toISOString(),
      p_reason: input.reason,
    },
    dependencies,
  ));
  const result = row.result_code;
  const nextPollAt = nullableTimestamp(row.next_poll_at);
  const lastSuccessAt = nullableTimestamp(row.last_success_at);
  const reason = row.defer_reason === null
    ? null
    : typeof row.defer_reason === "string" && CODE.test(row.defer_reason)
      ? row.defer_reason
      : undefined;
  const deferredAt = nullableTimestamp(row.deferred_at);
  if (
    !["deferred", "lease_lost"].includes(String(result))
    || xId(row.account_id) !== input.accountId
    || nextPollAt === undefined
    || lastSuccessAt === undefined
    || reason === undefined
    || deferredAt === undefined
    || (result === "deferred" && (!nextPollAt || reason !== input.reason || !deferredAt))
    || (result === "lease_lost" && deferredAt !== null)
  ) invalidResponse();

  return {
    result: result as XMentionPollDeferral["result"],
    accountId: input.accountId,
    nextPollAt,
    lastSuccessAt,
    reason,
    deferredAt,
  };
}

export async function commitXMentionDiscovery(
  input: CommitXMentionDiscoveryInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionDiscoveryCommit> {
  assertXId(input.accountId, "accountId");
  assertUuid(input.leaseToken, "leaseToken");
  if (input.previousSinceId !== null) {
    assertXId(input.previousSinceId, "previousSinceId");
  }
  if (input.nextSinceId !== null) assertXId(input.nextSinceId, "nextSinceId");
  if (input.previousContinuationUntilId !== null) {
    assertXId(
      input.previousContinuationUntilId,
      "previousContinuationUntilId",
    );
  }
  if (input.nextContinuationUntilId !== null) {
    assertXId(input.nextContinuationUntilId, "nextContinuationUntilId");
  }
  if (typeof input.completed !== "boolean") {
    invalidInput("completed must be a boolean.");
  }
  const mentions = normalizeDiscoveryItems(input.mentions);

  const row = oneRow(await callRpc(
    COMMIT_DISCOVERY_RPC,
    {
      p_account_id: input.accountId,
      p_lease_token: input.leaseToken.toLowerCase(),
      p_previous_since_id: input.previousSinceId,
      p_next_since_id: input.nextSinceId,
      p_previous_continuation_until_id: input.previousContinuationUntilId,
      p_next_continuation_until_id: input.nextContinuationUntilId,
      p_completed: input.completed,
      p_mentions: mentions,
    },
    dependencies,
  ));

  const result = row.result_code;
  const returnedAccountId = xId(row.account_id);
  const insertedCount = nonnegativeInteger(row.inserted_count);
  const existingCount = nonnegativeInteger(row.existing_count);
  const optOutCount = nonnegativeInteger(row.opt_out_count);
  const sinceId = nullableXId(row.resulting_since_id);
  const continuationUntilId = nullableXId(row.continuation_until_id);
  const continuationNewestId = nullableXId(row.continuation_newest_id);
  const initializedAt = nullableTimestamp(row.initialized_at);
  const nextPollAt = nullableTimestamp(row.next_poll_at);
  const lastSuccessAt = nullableTimestamp(row.last_success_at);

  if (
    ![
      "committed",
      "baseline_empty",
      "partial_committed",
      "lease_lost",
      "cursor_conflict",
    ].includes(
      String(result),
    )
    || returnedAccountId !== input.accountId
    || insertedCount === undefined
    || existingCount === undefined
    || optOutCount === undefined
    || sinceId === undefined
    || continuationUntilId === undefined
    || continuationNewestId === undefined
    || initializedAt === undefined
    || nextPollAt === undefined
    || lastSuccessAt === undefined
    || (result === "committed" && (!initializedAt || !nextPollAt || !lastSuccessAt))
    || (result === "baseline_empty"
      && (!nextPollAt || !initializedAt || !lastSuccessAt))
    || (result === "partial_committed"
      && (!nextPollAt || !continuationUntilId || !continuationNewestId))
    || (["committed", "baseline_empty"].includes(String(result))
      && (continuationUntilId !== null || continuationNewestId !== null))
    || (["lease_lost", "cursor_conflict"].includes(String(result))
      && (insertedCount !== 0 || existingCount !== 0 || optOutCount !== 0))
  ) invalidResponse();

  return {
    result: result as XMentionDiscoveryCommit["result"],
    accountId: input.accountId,
    insertedCount,
    existingCount,
    optOutCount,
    sinceId,
    continuationUntilId,
    continuationNewestId,
    initializedAt,
    nextPollAt,
    lastSuccessAt,
  };
}

function parseInboxItem(value: unknown): XMentionInboxItem {
  const row = record(value);
  const expectedKeys = [
    "post_id",
    "author_id",
    "conversation_id",
    "created_at",
    "content_hmac",
    "classification",
    "eligibility_reason",
    "state",
    "discovered_at",
    "state_changed_at",
    "claim_day",
    "claimed_at",
    "replied_at",
    "failed_at",
    "failure_code",
  ].sort();
  if (!row || Object.keys(row).sort().join("|") !== expectedKeys.join("|")) {
    invalidResponse();
  }

  const postId = xId(row.post_id);
  const authorId = xId(row.author_id);
  const conversationId = xId(row.conversation_id);
  const createdAt = timestamp(row.created_at);
  const discoveredAt = timestamp(row.discovered_at);
  const stateChangedAt = timestamp(row.state_changed_at);
  const claimDay = row.claim_day === null
    ? null
    : validDay(row.claim_day) ? row.claim_day : undefined;
  const claimedAt = nullableTimestamp(row.claimed_at);
  const repliedAt = nullableTimestamp(row.replied_at);
  const failedAt = nullableTimestamp(row.failed_at);
  const failureCode = row.failure_code === null
    ? null
    : typeof row.failure_code === "string" && CODE.test(row.failure_code)
      ? row.failure_code
      : undefined;
  const classification = row.classification;
  const state = row.state;
  if (
    !postId
    || !authorId
    || !conversationId
    || !createdAt
    || typeof row.content_hmac !== "string"
    || !CONTENT_HMAC.test(row.content_hmac)
    || !["auto_reply", "review", "ignore", "opt_out"].includes(
      String(classification),
    )
    || typeof row.eligibility_reason !== "string"
    || !CODE.test(row.eligibility_reason)
    || ![
      "eligible",
      "review_required",
      "ignored",
      "opted_out",
      "claimed",
      "replied",
      "failed",
    ].includes(String(state))
    || !discoveredAt
    || !stateChangedAt
    || claimDay === undefined
    || claimedAt === undefined
    || repliedAt === undefined
    || failedAt === undefined
    || failureCode === undefined
  ) invalidResponse();

  return {
    postId,
    authorId,
    conversationId,
    createdAt,
    contentHmac: row.content_hmac,
    classification: classification as XMentionClassification,
    eligibilityReason: row.eligibility_reason,
    state: state as XMentionInboxState,
    discoveredAt,
    stateChangedAt,
    claimDay,
    claimedAt,
    repliedAt,
    failedAt,
    failureCode,
  };
}

export async function listXMentionInbox(
  input: ListXMentionInboxInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionInboxResult> {
  assertXId(input.accountId, "accountId");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    invalidInput("X mention inbox limit must be an integer from 1 to 100.");
  }

  const row = oneRow(await callRpc(
    LIST_INBOX_RPC,
    { p_account_id: input.accountId, p_limit: limit },
    dependencies,
  ));
  const result = row.result_code;
  const reviewRequiredCount = nonnegativeInteger(row.review_required_count);
  if (
    !["listed", "account_not_found"].includes(String(result))
    || xId(row.account_id) !== input.accountId
    || reviewRequiredCount === undefined
    || !Array.isArray(row.items)
    || row.items.length > limit
    || (result === "account_not_found"
      && (reviewRequiredCount !== 0 || row.items.length !== 0))
  ) invalidResponse();

  return {
    result: result as XMentionInboxResult["result"],
    accountId: input.accountId,
    reviewRequiredCount,
    items: row.items.map(parseInboxItem),
  };
}

export async function claimNextEligibleXMention(
  accountId: string,
  dailyCap: number,
  dependencies: XMentionDependencies = {},
): Promise<XMentionReplyClaim> {
  assertXId(accountId, "accountId");
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 0 || dailyCap > 5) {
    invalidInput("X mention reply dailyCap must be an integer from 0 to 5.");
  }
  const row = oneRow(await callRpc(
    CLAIM_REPLY_RPC,
    { p_account_id: accountId, p_daily_cap: dailyCap },
    dependencies,
  ));

  const result = row.result_code;
  if (![
    "claimed",
    "no_eligible",
    "not_initialized",
    "poll_incomplete",
    "daily_cap_reached",
  ].includes(String(result))) {
    invalidResponse();
  }

  if (result !== "claimed") {
    const claimDay = row.claim_day === null
      ? null
      : validDay(row.claim_day) ? row.claim_day : undefined;
    if (
      xId(row.account_id) !== accountId
      || claimDay === undefined
      || row.post_id !== null
      || row.delivery_reference !== null
      || row.interaction_reference !== null
      || row.claim_token !== null
      || (["not_initialized", "poll_incomplete"].includes(String(result))
        && claimDay !== null)
      || (["no_eligible", "daily_cap_reached"].includes(String(result))
        && claimDay === null)
    ) invalidResponse();
    return {
      result: result as XMentionReplyClaim["result"],
      mention: null,
      claimDay,
    };
  }

  const postId = xId(row.post_id);
  const authorId = xId(row.author_id);
  const conversationId = xId(row.conversation_id);
  const createdAt = timestamp(row.source_created_at);
  const contentHmac = row.content_hmac;
  const deliveryReference = uuid(row.delivery_reference);
  const interactionReference = row.interaction_reference;
  const eligibilityReason = row.eligibility_reason;
  const claimToken = uuid(row.claim_token);
  const claimedAt = timestamp(row.claimed_at);
  if (
    xId(row.account_id) !== accountId
    || !postId
    || !authorId
    || !conversationId
    || !createdAt
    || typeof contentHmac !== "string"
    || !CONTENT_HMAC.test(contentHmac)
    || !deliveryReference
    || typeof interactionReference !== "string"
    || !OPAQUE_INTERACTION.test(interactionReference)
    || row.classification !== "auto_reply"
    || typeof eligibilityReason !== "string"
    || !CODE.test(eligibilityReason)
    || row.state !== "claimed"
    || !claimToken
    || !validDay(row.claim_day)
    || !claimedAt
  ) invalidResponse();

  return {
    result: "claimed",
    mention: {
      accountId,
      postId,
      authorId,
      conversationId,
      createdAt,
      contentHmac,
      deliveryReference,
      interactionReference,
      classification: "auto_reply",
      eligibilityReason,
      claimToken,
      claimDay: row.claim_day,
      claimedAt,
    },
    claimDay: row.claim_day,
  };
}

export async function getXMentionInteractionReference(
  accountId: string,
  postId: string,
  dependencies: XMentionDependencies = {},
): Promise<XMentionInteractionReference> {
  assertXId(accountId, "accountId");
  assertXId(postId, "postId");
  const row = oneRow(await callRpc(
    GET_INTERACTION_REFERENCE_RPC,
    { p_account_id: accountId, p_post_id: postId },
    dependencies,
  ));
  const result = row.result_code;
  const interactionReference = row.interaction_reference === null
    ? null
    : typeof row.interaction_reference === "string"
        && OPAQUE_INTERACTION.test(row.interaction_reference)
      ? row.interaction_reference
      : undefined;
  if (
    !["found", "not_found"].includes(String(result))
    || xId(row.account_id) !== accountId
    || xId(row.post_id) !== postId
    || interactionReference === undefined
    || (result === "found" && interactionReference === null)
    || (result === "not_found" && interactionReference !== null)
  ) invalidResponse();
  return {
    result: result as XMentionInteractionReference["result"],
    accountId,
    postId,
    interactionReference,
  };
}

function parseReplyMutation(
  row: Record<string, unknown>,
  input: XMentionReplyMutationInput,
  timestampField: "completed_at" | "failed_at",
): XMentionReplyMutation {
  const result = row.result_code;
  const state = row.state;
  const finishedAt = nullableTimestamp(row[timestampField]);
  const completionResponse = timestampField === "completed_at";
  if (
    ![
      "completed",
      "failed",
      "already_completed",
      "already_failed",
      "claim_conflict",
      "not_claimed",
      "not_found",
    ].includes(String(result))
    || xId(row.account_id) !== input.accountId
    || xId(row.post_id) !== input.postId
    || ![null, "claimed", "replied", "failed"].includes(state as never)
    || finishedAt === undefined
    || (completionResponse && result === "failed")
    || (!completionResponse && result === "completed")
    || (["completed", "already_completed"].includes(String(result))
      && (state !== "replied" || (!finishedAt && completionResponse)))
    || (["failed", "already_failed"].includes(String(result))
      && (state !== "failed" || (!finishedAt && !completionResponse)))
    || (result === "not_found" && (state !== null || finishedAt !== null))
  ) invalidResponse();

  return {
    result: result as XMentionReplyMutation["result"],
    accountId: input.accountId,
    postId: input.postId,
    state: state as XMentionReplyMutation["state"],
    finishedAt,
  };
}

function validateReplyMutationInput(input: XMentionReplyMutationInput): void {
  assertXId(input.accountId, "accountId");
  assertXId(input.postId, "postId");
  assertUuid(input.claimToken, "claimToken");
}

export async function completeXMentionReply(
  input: XMentionReplyMutationInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionReplyMutation> {
  validateReplyMutationInput(input);
  const row = oneRow(await callRpc(
    COMPLETE_REPLY_RPC,
    {
      p_account_id: input.accountId,
      p_post_id: input.postId,
      p_claim_token: input.claimToken.toLowerCase(),
    },
    dependencies,
  ));
  return parseReplyMutation(row, input, "completed_at");
}

export async function failXMentionReply(
  input: FailXMentionReplyInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionReplyMutation> {
  validateReplyMutationInput(input);
  if (!CODE.test(input.failureCode)) {
    invalidInput("failureCode must be a bounded machine-readable code.");
  }
  const row = oneRow(await callRpc(
    FAIL_REPLY_RPC,
    {
      p_account_id: input.accountId,
      p_post_id: input.postId,
      p_claim_token: input.claimToken.toLowerCase(),
      p_failure_code: input.failureCode,
    },
    dependencies,
  ));
  return parseReplyMutation(row, input, "failed_at");
}

export async function recordXMentionOptOut(
  input: RecordXMentionOptOutInput,
  dependencies: XMentionDependencies = {},
): Promise<XMentionOptOutMutation> {
  assertXId(input.accountId, "accountId");
  assertXId(input.authorId, "authorId");
  const sourcePostId = input.sourcePostId ?? null;
  if (sourcePostId !== null) assertXId(sourcePostId, "sourcePostId");

  const row = oneRow(await callRpc(
    OPT_OUT_RPC,
    {
      p_account_id: input.accountId,
      p_author_id: input.authorId,
      p_source_post_id: sourcePostId,
    },
    dependencies,
  ));
  const result = row.result_code;
  const returnedSourcePostId = nullableXId(row.source_post_id);
  const optedOutAt = nullableTimestamp(row.opted_out_at);
  const blockedCount = nonnegativeInteger(row.blocked_count);
  if (
    !["recorded", "already_recorded", "account_not_found"].includes(String(result))
    || xId(row.account_id) !== input.accountId
    || xId(row.author_id) !== input.authorId
    || returnedSourcePostId === undefined
    || optedOutAt === undefined
    || blockedCount === undefined
    || (result === "account_not_found" && (optedOutAt !== null || blockedCount !== 0))
    || (result !== "account_not_found" && !optedOutAt)
  ) invalidResponse();

  return {
    result: result as XMentionOptOutMutation["result"],
    accountId: input.accountId,
    authorId: input.authorId,
    sourcePostId: returnedSourcePostId,
    optedOutAt,
    blockedCount,
  };
}
