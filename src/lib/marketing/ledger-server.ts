import "server-only";

import { createHash } from "node:crypto";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import {
  reviewedMarketingCampaign,
  reviewedMarketingCampaignCanonicalPayload,
  type ReviewedMarketingCampaign,
  type ScheduledMarketingChannel,
} from "@/lib/marketing/scheduled-template";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import { readBoundedJsonBody } from "@/lib/request-body";
import type {
  MarketingAction,
  MarketingChannel,
  MarketingDailyCounters,
  MarketingDailyUsage,
} from "@/lib/marketing/types";

const SNAPSHOT_RPC = "get_marketing_delivery_snapshot";
const CLAIM_RPC = "claim_marketing_delivery";
const COMPLETE_RPC = "complete_marketing_delivery_claim";
const SCHEDULE_SLOT_RPC = "claim_marketing_schedule_slot";
const CAMPAIGN_QUEUE_RPC = "claim_next_marketing_campaign";
const VERIFY_CAMPAIGN_CLAIM_RPC = "verify_marketing_campaign_schedule_claim";
const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 12_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const X_INTERACTION_ID = /^\d{1,30}$/u;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const FAILURE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const X_PROVIDER_MESSAGE_ID = /^\d{1,19}$/u;
const DISCORD_PROVIDER_MESSAGE_ID = /^\d{1,30}$/u;
const SUBSTACK_EDITOR_URL =
  "https://defitutorials.substack.com/publish/post";

type Environment = Readonly<Record<string, string | undefined>>;
type MarketingDeliveryAction = Exclude<MarketingAction, "draft">;
type FinalStatus = "published" | "failed" | "requires_human_publish";

export const MARKETING_SCHEDULE_KEY = "weekday_product_update" as const;

export type MarketingLedgerErrorCode =
  | "not-configured"
  | "invalid-input"
  | "network-error"
  | "rpc-error"
  | "invalid-response";

export class MarketingLedgerError extends Error {
  constructor(
    readonly code: MarketingLedgerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketingLedgerError";
  }
}

export interface MarketingLedgerSnapshot {
  source: "durable" | "dry_run_empty";
  usage: MarketingDailyUsage;
  repliedInteractionIds: string[];
}

export type MarketingClaimResultCode =
  | "claimed"
  | "already_claimed"
  | "daily_cap_reached"
  | "interaction_already_claimed"
  | "idempotency_conflict";

export interface MarketingDeliveryClaim {
  result: MarketingClaimResultCode;
  status: "claimed" | FinalStatus | null;
  currentCount: number | null;
  day: string;
  providerMessageId: string | null;
  providerUrl: string | null;
  failureCode: string | null;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface ClaimMarketingDeliveryInput {
  idempotencyKey: string;
  runId: string;
  candidateId: string;
  contentHash: string;
  channel: Extract<MarketingChannel, "x" | "discord" | "substack">;
  action: MarketingDeliveryAction;
  interactionId: string | null;
  approvedBy: string;
  dailyCap: number;
}

export type MarketingCompletionResultCode =
  | "finalized"
  | "already_finalized"
  | "not_found"
  | "status_conflict";

export interface CompleteMarketingDeliveryInput {
  idempotencyKey: string;
  channel: Extract<MarketingChannel, "x" | "discord" | "substack">;
  action: MarketingDeliveryAction;
  status: FinalStatus;
  providerMessageId?: string;
  providerUrl?: string;
  failureCode?: string;
}

export interface MarketingDeliveryCompletion {
  result: MarketingCompletionResultCode;
  status: FinalStatus | null;
}

export type MarketingScheduleClaimResultCode =
  | "claimed"
  | "already_claimed"
  | "outside_schedule";

export interface MarketingScheduleSlotClaim {
  result: MarketingScheduleClaimResultCode;
  scheduleKey: typeof MARKETING_SCHEDULE_KEY;
  day: string;
  claimedAt: string | null;
}

export type MarketingCampaignQueueClaimResultCode =
  | "claimed"
  | "already_claimed"
  | "outside_schedule"
  | "no_pending_campaign";

export interface MarketingCampaignQueueClaim {
  result: MarketingCampaignQueueClaimResultCode;
  scheduleKey: typeof MARKETING_SCHEDULE_KEY;
  day: string;
  claimedAt: string | null;
  campaign: ReviewedMarketingCampaign | null;
}

export interface VerifyMarketingCampaignClaimInput {
  campaignId: string;
  channel: ScheduledMarketingChannel;
  slotDay: string;
  contentHash: string;
}

interface LedgerDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface LedgerConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

function hasServerSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

function ledgerConfiguration(env: Environment): LedgerConfiguration | null {
  if (env.OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED !== "true") return null;
  if (!hasServerSecret(env.SUPABASE_SERVICE_ROLE_KEY)) return null;

  const rawUrl = env.SUPABASE_URL;
  if (
    !isMarketingLedgerSupabaseUrl(
      rawUrl,
      env.OPENZAPS_MARKETING_SUPABASE_PROJECT_REF,
      env.NODE_ENV !== "production",
    )
    || !rawUrl
  ) return null;
  try {
    const url = new URL(rawUrl);
    return {
      restUrl: new URL("rest/v1/", url.href.endsWith("/") ? url : `${url.href}/`).toString(),
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    };
  } catch {
    return null;
  }
}

export function marketingLedgerConfigured(env: Environment = process.env): boolean {
  return ledgerConfiguration(env) !== null;
}

function requireLedgerConfiguration(env: Environment): LedgerConfiguration {
  const configured = ledgerConfiguration(env);
  if (!configured) {
    throw new MarketingLedgerError(
      "not-configured",
      "The durable marketing delivery ledger is not configured.",
    );
  }
  return configured;
}

async function callLedgerRpc(
  name:
    | typeof SNAPSHOT_RPC
    | typeof CLAIM_RPC
    | typeof COMPLETE_RPC
    | typeof SCHEDULE_SLOT_RPC
    | typeof CAMPAIGN_QUEUE_RPC
    | typeof VERIFY_CAMPAIGN_CLAIM_RPC,
  body: Record<string, unknown>,
  dependencies: LedgerDependencies,
): Promise<unknown> {
  const configuration = requireLedgerConfiguration(dependencies.env ?? process.env);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL(`rpc/${name}`, configuration.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configuration.serviceRoleKey,
          authorization: `Bearer ${configuration.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new MarketingLedgerError(
      "network-error",
      "The durable marketing delivery ledger could not be reached.",
    );
  }

  if (!response.ok) {
    throw new MarketingLedgerError(
      "rpc-error",
      `The durable marketing delivery ledger rejected the request (${response.status}).`,
      response.status,
    );
  }

  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid response.",
    );
  }
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid response.",
    );
  }
  return value[0] as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isWeekday(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function nullableBoundedString(
  value: unknown,
  maximum: number,
  pattern?: RegExp,
): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    return undefined;
  }
  return value;
}

function validateInteractionIds(interactionIds: readonly string[]): string[] {
  const unique = [...new Set(interactionIds)];
  if (
    unique.length > 100 ||
    unique.some((interactionId) => !X_INTERACTION_ID.test(interactionId))
  ) {
    throw new MarketingLedgerError(
      "invalid-input",
      "Marketing interaction IDs must be 1-30 digit X post IDs.",
    );
  }
  return unique;
}

export function emptyDryRunMarketingLedgerSnapshot(day: string): MarketingLedgerSnapshot {
  if (!validDay(day)) {
    throw new MarketingLedgerError("invalid-input", "Dry-run ledger day must be a valid UTC date.");
  }
  return {
    source: "dry_run_empty",
    usage: {
      day,
      counts: {
        xPosts: 0,
        xReplies: 0,
        discordPosts: 0,
        substackTutorials: 0,
        directMessages: 0,
      },
    },
    repliedInteractionIds: [],
  };
}

export async function getMarketingLedgerSnapshot(
  interactionIds: readonly string[] = [],
  dependencies: LedgerDependencies = {},
): Promise<MarketingLedgerSnapshot> {
  const requested = validateInteractionIds(interactionIds);
  const row = oneRow(
    await callLedgerRpc(
      SNAPSHOT_RPC,
      { p_interaction_ids: requested },
      dependencies,
    ),
  );
  const counts: Array<[keyof MarketingDailyCounters, unknown]> = [
    ["xPosts", row.x_posts],
    ["xReplies", row.x_replies],
    ["discordPosts", row.discord_posts],
    ["substackTutorials", row.substack_tutorials],
    ["directMessages", row.direct_messages],
  ];
  const day = row.snapshot_day;
  const replied = row.replied_interaction_ids;
  if (
    !validDay(day) ||
    !Array.isArray(replied) ||
    replied.some((interactionId) => typeof interactionId !== "string" || !X_INTERACTION_ID.test(interactionId))
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid snapshot.",
    );
  }

  const parsedCounts = Object.fromEntries(
    counts.map(([key, value]) => [key, nonnegativeInteger(value)]),
  ) as Record<keyof MarketingDailyCounters, number | null>;
  if (Object.values(parsedCounts).some((value) => value === null)) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned invalid counters.",
    );
  }

  return {
    source: "durable",
    usage: {
      day,
      counts: parsedCounts as MarketingDailyCounters,
    },
    repliedInteractionIds: [...new Set(replied)],
  };
}

function validDeliveryIdentity(input: ClaimMarketingDeliveryInput): boolean {
  const actionAllowed =
    (input.channel === "x" && ["broadcast", "reply"].includes(input.action)) ||
    (input.channel === "discord" && input.action === "broadcast") ||
    (input.channel === "substack" && input.action === "prepare_tutorial");
  const interactionValid =
    input.channel === "x" && input.action === "reply"
      ? input.interactionId !== null && X_INTERACTION_ID.test(input.interactionId)
      : input.interactionId === null;
  return actionAllowed && interactionValid;
}

function validCompletionIdentity(
  input: Pick<CompleteMarketingDeliveryInput, "channel" | "action">,
): boolean {
  return (
    (input.channel === "x" &&
      (input.action === "broadcast" || input.action === "reply")) ||
    (input.channel === "discord" && input.action === "broadcast") ||
    (input.channel === "substack" && input.action === "prepare_tutorial")
  );
}

function validProviderReceipt(
  input: Pick<
    CompleteMarketingDeliveryInput,
    "channel" | "action" | "status" | "providerMessageId" | "providerUrl" | "failureCode"
  >,
): boolean {
  if (!validCompletionIdentity(input)) return false;
  if (
    (input.providerMessageId !== undefined &&
      containsCredentialLikeData(input.providerMessageId)) ||
    (input.providerUrl !== undefined &&
      containsCredentialLikeData(input.providerUrl))
  ) {
    return false;
  }
  if (input.status === "failed") {
    return (
      input.providerMessageId === undefined &&
      input.providerUrl === undefined &&
      typeof input.failureCode === "string" &&
      FAILURE_CODE.test(input.failureCode)
    );
  }
  if (input.failureCode !== undefined) return false;
  if (input.channel === "x") {
    return (
      input.status === "published" &&
      typeof input.providerMessageId === "string" &&
      X_PROVIDER_MESSAGE_ID.test(input.providerMessageId) &&
      input.providerUrl ===
        `https://x.com/i/web/status/${input.providerMessageId}`
    );
  }
  if (input.channel === "discord") {
    return (
      input.status === "published" &&
      typeof input.providerMessageId === "string" &&
      DISCORD_PROVIDER_MESSAGE_ID.test(input.providerMessageId) &&
      input.providerUrl === undefined
    );
  }
  return (
    input.status === "requires_human_publish" &&
    input.providerMessageId === undefined &&
    input.providerUrl === SUBSTACK_EDITOR_URL
  );
}

export async function claimMarketingDelivery(
  input: ClaimMarketingDeliveryInput,
  dependencies: LedgerDependencies = {},
): Promise<MarketingDeliveryClaim> {
  if (
    !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
    input.runId.length < 1 ||
    input.runId.length > 200 ||
    input.candidateId.length < 1 ||
    input.candidateId.length > 300 ||
    !CONTENT_HASH.test(input.contentHash) ||
    input.approvedBy.trim().length < 1 ||
    input.approvedBy.trim().length > 120 ||
    !Number.isSafeInteger(input.dailyCap) ||
    input.dailyCap < 0 ||
    input.dailyCap > 100 ||
    !validDeliveryIdentity(input)
  ) {
    throw new MarketingLedgerError("invalid-input", "Marketing delivery claim input is invalid.");
  }

  const row = oneRow(
    await callLedgerRpc(
      CLAIM_RPC,
      {
        p_idempotency_key: input.idempotencyKey,
        p_run_id: input.runId,
        p_candidate_id: input.candidateId,
        p_content_hash: input.contentHash,
        p_channel: input.channel,
        p_action: input.action,
        p_interaction_id: input.interactionId,
        p_approved_by: input.approvedBy.trim(),
        p_daily_cap: input.dailyCap,
      },
      dependencies,
    ),
  );

  const result = row.result_code;
  if (
    ![
      "claimed",
      "already_claimed",
      "daily_cap_reached",
      "interaction_already_claimed",
      "idempotency_conflict",
    ].includes(String(result))
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an unknown claim result.",
    );
  }
  const day = row.resulting_day;
  const count = row.current_count === null ? null : nonnegativeInteger(row.current_count);
  const status =
    row.resulting_status === null
      ? null
      : ["claimed", "published", "failed", "requires_human_publish"].includes(
            String(row.resulting_status),
          )
        ? (row.resulting_status as MarketingDeliveryClaim["status"])
        : undefined;
  const providerMessageId = nullableBoundedString(row.provider_message_id, 200);
  const providerUrl = nullableBoundedString(row.provider_url, 2_048);
  const failureCode = nullableBoundedString(row.failure_code, 100, FAILURE_CODE);
  const claimedAt =
    row.claimed_at === null
      ? null
      : validTimestamp(row.claimed_at)
        ? row.claimed_at
        : undefined;
  const completedAt =
    row.completed_at === null
      ? null
      : validTimestamp(row.completed_at)
        ? row.completed_at
        : undefined;
  if (
    !validDay(day) ||
    (count === null && row.current_count !== null) ||
    status === undefined ||
    providerMessageId === undefined ||
    providerUrl === undefined ||
    failureCode === undefined ||
    claimedAt === undefined ||
    completedAt === undefined
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid claim result.",
    );
  }

  const noRowMetadata =
    providerMessageId === null &&
    providerUrl === null &&
    failureCode === null &&
    claimedAt === null &&
    completedAt === null;
  const validRowStatus =
    status === "claimed"
      ? providerMessageId === null &&
        providerUrl === null &&
        failureCode === null &&
        claimedAt !== null &&
        completedAt === null
      : status === "published"
        ? validProviderReceipt({
            channel: input.channel,
            action: input.action,
            status,
            ...(providerMessageId === null ? {} : { providerMessageId }),
            ...(providerUrl === null ? {} : { providerUrl }),
            ...(failureCode === null ? {} : { failureCode }),
          }) &&
          claimedAt !== null &&
          completedAt !== null
        : status === "failed"
          ? providerMessageId === null &&
            providerUrl === null &&
            failureCode !== null &&
            claimedAt !== null &&
            completedAt !== null
          : status === "requires_human_publish"
            ? validProviderReceipt({
                channel: input.channel,
                action: input.action,
                status,
                ...(providerMessageId === null ? {} : { providerMessageId }),
                ...(providerUrl === null ? {} : { providerUrl }),
                ...(failureCode === null ? {} : { failureCode }),
              }) &&
              claimedAt !== null &&
              completedAt !== null
            : false;
  const semanticResult =
    result === "claimed"
      ? status === "claimed" && count !== null && count >= 1 && validRowStatus
      : result === "already_claimed"
        ? status !== null && count !== null && count >= 1 && validRowStatus
        : result === "daily_cap_reached"
          ? status === null && count !== null && noRowMetadata
          : result === "interaction_already_claimed"
            ? status === null && count === null && noRowMetadata
            : result === "idempotency_conflict"
              ? status !== null && count === null && noRowMetadata
              : false;
  if (!semanticResult) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an inconsistent claim result.",
    );
  }

  return {
    result: result as MarketingClaimResultCode,
    status,
    currentCount: count,
    day,
    providerMessageId,
    providerUrl,
    failureCode,
    claimedAt,
    completedAt,
  };
}

export async function completeMarketingDeliveryClaim(
  input: CompleteMarketingDeliveryInput,
  dependencies: LedgerDependencies = {},
): Promise<MarketingDeliveryCompletion> {
  if (
    !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
    !validProviderReceipt(input)
  ) {
    throw new MarketingLedgerError("invalid-input", "Marketing delivery completion input is invalid.");
  }

  const row = oneRow(
    await callLedgerRpc(
      COMPLETE_RPC,
      {
        p_idempotency_key: input.idempotencyKey,
        p_channel: input.channel,
        p_action: input.action,
        p_status: input.status,
        p_provider_message_id: input.providerMessageId ?? null,
        p_provider_url: input.providerUrl ?? null,
        p_failure_code: input.failureCode ?? null,
      },
      dependencies,
    ),
  );
  const result = row.result_code;
  const status =
    row.resulting_status === null
      ? null
      : ["published", "failed", "requires_human_publish"].includes(String(row.resulting_status))
        ? (row.resulting_status as FinalStatus)
        : undefined;
  if (
    !["finalized", "already_finalized", "not_found", "status_conflict"].includes(String(result)) ||
    status === undefined ||
    ((result === "finalized" || result === "already_finalized") &&
      status !== input.status) ||
    (result === "not_found" && status !== null)
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid completion result.",
    );
  }
  return {
    result: result as MarketingCompletionResultCode,
    status,
  };
}

export async function claimMarketingScheduleSlot(
  dependencies: LedgerDependencies = {},
): Promise<MarketingScheduleSlotClaim> {
  const row = oneRow(
    await callLedgerRpc(SCHEDULE_SLOT_RPC, {}, dependencies),
  );
  const result = row.result_code;
  const scheduleKey = row.schedule_key;
  const day = row.slot_day;
  const claimedAt =
    row.claimed_at === null
      ? null
      : validTimestamp(row.claimed_at)
        ? row.claimed_at
        : undefined;
  const knownResult = [
    "claimed",
    "already_claimed",
    "outside_schedule",
  ].includes(String(result));
  const semanticResult =
    (result === "claimed" || result === "already_claimed")
      ? claimedAt !== null && claimedAt !== undefined && validDay(day) && isWeekday(day)
      : result === "outside_schedule"
        ? claimedAt === null && validDay(day) && !isWeekday(day)
        : false;

  if (
    !knownResult ||
    scheduleKey !== MARKETING_SCHEDULE_KEY ||
    !validDay(day) ||
    claimedAt === undefined ||
    !semanticResult
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing delivery ledger returned an invalid schedule slot.",
    );
  }

  return {
    result: result as MarketingScheduleClaimResultCode,
    scheduleKey: MARKETING_SCHEDULE_KEY,
    day,
    claimedAt,
  };
}

function reviewedCampaignRow(
  row: Record<string, unknown>,
): ReviewedMarketingCampaign | null {
  if (
    typeof row.campaign_id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(row.campaign_id) ||
    (row.channel !== "x" && row.channel !== "discord")
  ) {
    return null;
  }

  let reviewed: ReviewedMarketingCampaign;
  try {
    reviewed = reviewedMarketingCampaign(
      row.campaign_id,
      row.channel as ScheduledMarketingChannel,
    );
  } catch {
    return null;
  }

  const queueOrder = nonnegativeInteger(row.queue_order);
  const notBefore =
    row.not_before === null
      ? null
      : validTimestamp(row.not_before)
        ? new Date(row.not_before).toISOString()
        : undefined;
  const contentHash = nullableBoundedString(row.content_hash, 64, CONTENT_HASH);
  if (
    queueOrder === null ||
    notBefore === undefined ||
    contentHash !== reviewed.contentHash
  ) {
    return null;
  }

  const databasePayload = {
    id: row.campaign_id,
    channel: row.channel,
    queueOrder,
    notBefore,
    body: row.body,
    links: row.links,
    topics: row.topics,
    disclosures: row.disclosures,
    claims: row.claims,
    flags: row.flags,
    requiredFacts: row.required_facts,
    canonicalSourceUrls: row.canonical_source_urls,
  };
  const expectedPayload = reviewedMarketingCampaignCanonicalPayload(reviewed);
  const calculatedHash = createHash("sha256")
    .update(JSON.stringify(expectedPayload))
    .digest("hex");
  if (
    calculatedHash !== reviewed.contentHash ||
    !sameStructuredValue(databasePayload, expectedPayload)
  ) {
    return null;
  }
  return reviewed;
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameStructuredValue(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameStructuredValue(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Claim at most one immutable, source-reviewed campaign/channel pair for the
 * current UTC weekday. A no-pending result performs no queue write and must
 * never start a workflow.
 */
export async function claimNextReviewedMarketingCampaign(
  requestedChannels: readonly ScheduledMarketingChannel[],
  dependencies: LedgerDependencies = {},
): Promise<MarketingCampaignQueueClaim> {
  const channels = [...new Set(requestedChannels)];
  if (
    channels.length < 1 ||
    channels.length > 2 ||
    channels.some((channel) => channel !== "x" && channel !== "discord")
  ) {
    throw new MarketingLedgerError(
      "invalid-input",
      "Reviewed campaign channels must be a non-empty X/Discord set.",
    );
  }

  const row = oneRow(
    await callLedgerRpc(
      CAMPAIGN_QUEUE_RPC,
      { p_channels: channels },
      dependencies,
    ),
  );
  const result = row.result_code;
  const scheduleKey = row.schedule_key;
  const day = row.slot_day;
  const claimedAt =
    row.claimed_at === null
      ? null
      : validTimestamp(row.claimed_at)
        ? row.claimed_at
        : undefined;
  const knownResult = [
    "claimed",
    "already_claimed",
    "outside_schedule",
    "no_pending_campaign",
  ].includes(String(result));
  const campaign = result === "claimed" ? reviewedCampaignRow(row) : null;
  const emptyCampaignFields = [
    row.campaign_id,
    row.channel,
    row.queue_order,
    row.not_before,
    row.body,
    row.links,
    row.topics,
    row.disclosures,
    row.claims,
    row.flags,
    row.required_facts,
    row.canonical_source_urls,
    row.content_hash,
  ].every((value) => value === null);
  const semanticResult =
    result === "claimed"
      ? campaign !== null &&
        claimedAt !== null &&
        claimedAt !== undefined &&
        validDay(day) &&
        isWeekday(day)
      : result === "already_claimed"
        ? emptyCampaignFields &&
          claimedAt !== null &&
          claimedAt !== undefined &&
          validDay(day) &&
          isWeekday(day)
        : result === "outside_schedule"
          ? emptyCampaignFields && claimedAt === null && validDay(day) && !isWeekday(day)
          : result === "no_pending_campaign"
            ? emptyCampaignFields && claimedAt === null && validDay(day) && isWeekday(day)
            : false;

  if (
    !knownResult ||
    scheduleKey !== MARKETING_SCHEDULE_KEY ||
    !validDay(day) ||
    claimedAt === undefined ||
    !semanticResult
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing campaign queue returned an invalid claim.",
    );
  }

  return {
    result: result as MarketingCampaignQueueClaimResultCode,
    scheduleKey: MARKETING_SCHEDULE_KEY,
    day,
    claimedAt,
    campaign,
  };
}

export async function verifyReviewedMarketingCampaignClaim(
  input: VerifyMarketingCampaignClaimInput,
  dependencies: LedgerDependencies = {},
): Promise<boolean> {
  let campaign: ReviewedMarketingCampaign;
  try {
    campaign = reviewedMarketingCampaign(input.campaignId, input.channel);
  } catch {
    throw new MarketingLedgerError(
      "invalid-input",
      "The reviewed campaign claim identity is invalid.",
    );
  }
  if (
    !validDay(input.slotDay) ||
    !isWeekday(input.slotDay) ||
    !CONTENT_HASH.test(input.contentHash) ||
    input.contentHash !== campaign.contentHash
  ) {
    throw new MarketingLedgerError(
      "invalid-input",
      "The reviewed campaign claim identity is invalid.",
    );
  }

  const row = oneRow(
    await callLedgerRpc(
      VERIFY_CAMPAIGN_CLAIM_RPC,
      {
        p_campaign_id: campaign.id,
        p_channel: campaign.channel,
        p_slot_day: input.slotDay,
        p_content_hash: campaign.contentHash,
      },
      dependencies,
    ),
  );
  if (typeof row.verified !== "boolean") {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing campaign queue returned an invalid verification.",
    );
  }
  const claimedAt =
    row.claimed_at === null
      ? null
      : validTimestamp(row.claimed_at)
        ? row.claimed_at
        : undefined;
  if (
    claimedAt === undefined ||
    (row.verified && claimedAt === null) ||
    (!row.verified && claimedAt !== null)
  ) {
    throw new MarketingLedgerError(
      "invalid-response",
      "The durable marketing campaign queue returned an inconsistent verification.",
    );
  }
  return row.verified;
}
