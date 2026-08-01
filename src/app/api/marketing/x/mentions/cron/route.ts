import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isCronAuthorized } from "@/lib/cron-auth";
import { readMarketingConfig } from "@/lib/marketing/config";
import {
  ChannelAdapterError,
  fetchXMentionsPage,
  postXDeterministicMentionReply,
  verifyXMentionById,
  type XMentionObservation,
} from "@/lib/marketing/channels";
import {
  claimMarketingDelivery,
  completeMarketingDeliveryClaim,
  getMarketingLedgerSnapshot,
} from "@/lib/marketing/ledger-server";
import {
  claimNextEligibleXMention,
  claimXMentionPollLease,
  commitXMentionDiscovery,
  completeXMentionReply,
  deferXMentionPoll,
  failXMentionReply,
  marketingXMentionsConfigured,
  type ClaimedXMention,
  type XMentionDiscoveryItem,
} from "@/lib/marketing/x-mentions-server";
import {
  classifyXMention,
  readXMentionAutomationConfig,
  renderXMentionReply,
  xMentionContentHash,
  X_MENTION_TEMPLATE_VERSION,
  type XMentionClassificationResult,
  type XMentionTemplateId,
} from "@/lib/marketing/x-mentions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HEADERS = { "cache-control": "private, no-store" } as const;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const X_REQUEST_TIMEOUT_MS = 8_000;
const X_ACCOUNT_ID = /^[1-9]\d{0,18}$/u;

function compareXIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

interface DiscoveryResult {
  insertedCount: number;
  existingCount: number;
  optOutCount: number;
  baseline: boolean;
  completed: boolean;
}

function response(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function storedClassification(
  result: XMentionClassificationResult,
  autoReplyReady: boolean,
): Pick<XMentionDiscoveryItem, "classification" | "eligibilityReason"> {
  if (result.templateId) {
    if (!autoReplyReady) {
      return {
        classification: "review",
        eligibilityReason: "auto_reply_not_ready",
      };
    }
    return {
      classification: "auto_reply",
      eligibilityReason: `template:${result.templateId}`,
    };
  }
  if (result.classification === "opt_out") {
    return { classification: "opt_out", eligibilityReason: "explicit_opt_out" };
  }
  if (
    [
      "review_only",
      "blocked_external_link",
      "blocked_media",
      "blocked_protected",
      "blocked_sensitive",
      "blocked_withheld",
    ].includes(result.classification)
  ) {
    return { classification: "review", eligibilityReason: result.reason };
  }
  return { classification: "ignore", eligibilityReason: result.reason };
}

function discoveryItem(
  mention: XMentionObservation,
  authenticatedAccountId: string,
  authenticatedUsername: string,
  autoReplyReady: boolean,
): XMentionDiscoveryItem {
  const classification = classifyXMention(mention, {
    authenticatedAccountId,
    expectedUsername: authenticatedUsername.toLowerCase(),
  });
  return {
    postId: mention.id,
    authorId: mention.authorId,
    conversationId: mention.conversationId,
    createdAt: mention.createdAt,
    contentHmac: xMentionContentHash(mention.text),
    ...storedClassification(classification, autoReplyReady),
  };
}

function nextPollAfter(error: unknown): { at: string; reason: string } {
  const now = Date.now();
  if (error instanceof ChannelAdapterError && error.code === "rate-limited") {
    const resetAt = error.details.rateLimit?.resetAt;
    const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
    const retryMs = error.details.retryAfterMs;
    const candidate = Number.isFinite(resetMs)
      ? resetMs
      : Number.isSafeInteger(retryMs)
        ? now + Number(retryMs)
        : now + 15 * 60 * 1_000;
    return {
      at: new Date(Math.max(now + 60_000, candidate)).toISOString(),
      reason: "x_rate_limited",
    };
  }
  return {
    at: new Date(now + 5 * 60 * 1_000).toISOString(),
    reason: error instanceof ChannelAdapterError
      ? `x_${error.code.replaceAll("-", "_")}`
      : "x_discovery_failed",
  };
}

async function discoverMentions(
  accountId: string,
  autoReplyReady: boolean,
): Promise<
  DiscoveryResult | { skipped: "leased" | "not_due" | "compliance_hold" }
> {
  const lease = await claimXMentionPollLease(accountId);
  if (lease.result !== "claimed") {
    return { skipped: lease.result };
  }

  const items = new Map<string, XMentionDiscoveryItem>();
  let paginationToken: string | undefined;
  const stableUntilId = lease.continuationUntilId ?? undefined;
  let continuationUntilId = lease.continuationUntilId;
  let newestId = lease.continuationNewestId ?? lease.sinceId;
  let previousPageOldestId: string | null = null;
  const baselineStartTime =
    !lease.sinceId && !lease.baselineRequired && lease.lastSuccessAt
      ? new Date(Date.parse(lease.lastSuccessAt) - 5 * 60 * 1_000).toISOString()
      : undefined;
  let completed = false;
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await fetchXMentionsPage(
        {
          ...(lease.sinceId ? { sinceId: lease.sinceId } : {}),
          ...(stableUntilId ? { untilId: stableUntilId } : {}),
          ...(baselineStartTime ? { startTime: baselineStartTime } : {}),
          ...(paginationToken ? { paginationToken } : {}),
          maxResults: PAGE_SIZE,
        },
        { requestTimeoutMs: X_REQUEST_TIMEOUT_MS },
      );
      if (page.authenticatedAccountId !== accountId) {
        throw new Error("X mention account identity changed.");
      }
      if (
        previousPageOldestId
        && page.newestId
        && compareXIds(page.newestId, previousPageOldestId) >= 0
      ) {
        throw new Error("X mention pagination returned overlapping page bounds.");
      }
      if (
        pageNumber === 0
        && lease.continuationUntilId === null
        && page.newestId
      ) newestId = page.newestId;
      if (page.oldestId) continuationUntilId = page.oldestId;
      previousPageOldestId = page.oldestId;
      for (const mention of page.mentions) {
        // X policy forbids retaining protected or withheld observations.
        if (mention.authorProtected || mention.isWithheld) continue;
        const item = discoveryItem(
          mention,
          page.authenticatedAccountId,
          page.authenticatedUsername,
          autoReplyReady,
        );
        const existing = items.get(item.postId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error("X returned conflicting mention metadata.");
        }
        items.set(item.postId, item);
      }
      paginationToken = page.nextToken ?? undefined;
      if (!paginationToken) {
        completed = true;
        break;
      }
      if (!continuationUntilId) {
        throw new Error("X returned a continuation without a stable oldest id.");
      }
      if (page.rateLimit?.remaining === 0) break;
    }
  } catch (error) {
    if (items.size > 0 && continuationUntilId && newestId) {
      const partial = await commitXMentionDiscovery({
        accountId,
        leaseToken: lease.leaseToken,
        previousSinceId: lease.sinceId,
        nextSinceId: newestId,
        previousContinuationUntilId: lease.continuationUntilId,
        nextContinuationUntilId: continuationUntilId,
        completed: false,
        mentions: [...items.values()],
      }).catch(() => null);
      if (partial?.result === "partial_committed") {
        return {
          insertedCount: partial.insertedCount,
          existingCount: partial.existingCount,
          optOutCount: partial.optOutCount,
          baseline: lease.baselineRequired,
          completed: false,
        };
      }
    }
    const deferred = nextPollAfter(error);
    await deferXMentionPoll({
      accountId,
      leaseToken: lease.leaseToken,
      nextPollAt: deferred.at,
      reason: deferred.reason,
    }).catch(() => undefined);
    throw error;
  }

  const committed = await commitXMentionDiscovery({
    accountId,
    leaseToken: lease.leaseToken,
    previousSinceId: lease.sinceId,
    nextSinceId: newestId,
    previousContinuationUntilId: lease.continuationUntilId,
    nextContinuationUntilId: completed ? null : continuationUntilId,
    completed,
    mentions: [...items.values()],
  });
  if (
    committed.result === "lease_lost"
    || committed.result === "cursor_conflict"
  ) {
    throw new Error("The durable X mention cursor changed before commit.");
  }
  return {
    insertedCount: committed.insertedCount,
    existingCount: committed.existingCount,
    optOutCount: committed.optOutCount,
    baseline: lease.baselineRequired,
    completed: ["committed", "baseline_empty"].includes(committed.result),
  };
}

function sameHash(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function claimedTemplate(mention: ClaimedXMention): XMentionTemplateId | null {
  const prefix = "template:";
  if (!mention.eligibilityReason.startsWith(prefix)) return null;
  const templateId = mention.eligibilityReason.slice(prefix.length);
  try {
    renderXMentionReply(templateId as XMentionTemplateId);
    return templateId as XMentionTemplateId;
  } catch {
    return null;
  }
}

async function failClaim(
  mention: ClaimedXMention,
  failureCode: string,
): Promise<void> {
  await failXMentionReply({
    accountId: mention.accountId,
    postId: mention.postId,
    claimToken: mention.claimToken,
    failureCode,
  }).catch(() => undefined);
}

async function deliverOneReply(
  accountId: string,
  dailyCap: number,
): Promise<Record<string, unknown>> {
  const usage = await getMarketingLedgerSnapshot();
  if (usage.usage.counts.xReplies >= dailyCap) {
    return { replyStatus: "daily_cap_reached" };
  }

  const claimed = await claimNextEligibleXMention(accountId, dailyCap);
  if (claimed.result !== "claimed" || !claimed.mention) {
    return { replyStatus: claimed.result };
  }
  const mention = claimed.mention;
  const templateId = claimedTemplate(mention);
  if (!templateId) {
    await failClaim(mention, "invalid_template_claim");
    return { replyStatus: "blocked", reason: "invalid_template_claim" };
  }

  let verified;
  try {
    verified = await verifyXMentionById(mention.postId, mention.authorId, {
      requestTimeoutMs: X_REQUEST_TIMEOUT_MS,
    });
  } catch {
    await failClaim(mention, "revalidation_failed");
    return { replyStatus: "blocked", reason: "revalidation_failed" };
  }
  const reclassified = classifyXMention(verified.mention, {
    authenticatedAccountId: verified.authenticatedAccountId,
    expectedUsername: verified.authenticatedUsername.toLowerCase(),
  });
  const currentHash = xMentionContentHash(verified.mention.text);
  if (
    !sameHash(currentHash, mention.contentHmac)
    || verified.authenticatedAccountId !== accountId
    || verified.mention.conversationId !== mention.conversationId
    || verified.mention.createdAt !== mention.createdAt
    || reclassified.templateId !== templateId
    || !reclassified.eligibleForAutomaticReply
  ) {
    await failClaim(mention, "content_or_policy_changed");
    return { replyStatus: "blocked", reason: "content_or_policy_changed" };
  }

  const body = renderXMentionReply(templateId);
  const deliveryReference = mention.deliveryReference;
  const idempotencyKey = `x:reply:${deliveryReference}`;
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      templateVersion: X_MENTION_TEMPLATE_VERSION,
      templateId,
      deliveryReference,
      body,
    }))
    .digest("hex");
  let delivery;
  try {
    delivery = await claimMarketingDelivery({
      idempotencyKey,
      runId: `x-mention-cron:${deliveryReference}`,
      candidateId: `x-mention:${templateId}:${deliveryReference}`,
      contentHash,
      channel: "x",
      action: "reply",
      interactionId: mention.postId,
      approvedBy:
        `x-auto-response-campaign:reviewed-template-v${X_MENTION_TEMPLATE_VERSION}`,
      dailyCap,
    });
  } catch {
    await failClaim(mention, "delivery_admission_unavailable");
    return { replyStatus: "failed", reason: "delivery_admission_unavailable" };
  }

  if (delivery.result === "already_claimed") {
    if (delivery.status === "published") {
      await completeXMentionReply({
        accountId: mention.accountId,
        postId: mention.postId,
        claimToken: mention.claimToken,
      });
      return { replyStatus: "already_published" };
    }
    await failClaim(
      mention,
      delivery.status === "failed"
        ? "prior_delivery_failed"
        : "delivery_reconciliation_required",
    );
    return {
      replyStatus: "blocked",
      reason: delivery.status === "failed"
        ? "prior_delivery_failed"
        : "delivery_reconciliation_required",
    };
  }
  if (delivery.result !== "claimed") {
    await failClaim(mention, `delivery_${delivery.result}`);
    return { replyStatus: "blocked", reason: `delivery_${delivery.result}` };
  }

  let receipt;
  try {
    receipt = await postXDeterministicMentionReply({
      templateId,
      inReplyToTweetId: mention.postId,
      authenticatedAccountId: verified.authenticatedAccountId,
      idempotencyKey,
    }, {
      requestTimeoutMs: X_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const definitivePreWriteFailure =
      error instanceof ChannelAdapterError
      && ["invalid-input", "not-configured"].includes(error.code);
    if (definitivePreWriteFailure) {
      await completeMarketingDeliveryClaim({
        idempotencyKey,
        channel: "x",
        action: "reply",
        status: "failed",
        failureCode: "x_prewrite_failed",
      }).catch(() => undefined);
      await failClaim(mention, "x_prewrite_failed");
      return { replyStatus: "failed", reason: "x_prewrite_failed" };
    }
    return {
      replyStatus: "reconciliation_required",
      reason: "x_delivery_outcome_ambiguous",
    };
  }

  const finalized = await completeMarketingDeliveryClaim({
    idempotencyKey,
    channel: "x",
    action: "reply",
    status: "published",
    providerMessageId: receipt.providerMessageId,
    providerUrl: receipt.providerUrl,
  }).catch(() => null);
  if (
    !finalized
    || !["finalized", "already_finalized"].includes(finalized.result)
    || finalized.status !== "published"
  ) {
    return {
      replyStatus: "reconciliation_required",
      reason: "provider_receipt_not_finalized",
    };
  }

  const completed = await completeXMentionReply({
    accountId: mention.accountId,
    postId: mention.postId,
    claimToken: mention.claimToken,
  }).catch(() => null);
  if (!completed || !["completed", "already_completed"].includes(completed.result)) {
    return {
      replyStatus: "reconciliation_required",
      reason: "mention_receipt_not_finalized",
    };
  }
  return { replyStatus: "published" };
}

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return response({ error: "Unauthorized." }, 401);
  }

  const config = readXMentionAutomationConfig();
  if (!config.ingestRequested) {
    return response({ skipped: true, reason: "X mention ingestion is disabled." });
  }
  if (!config.ingestReady || !marketingXMentionsConfigured()) {
    return response(
      {
        error: "X mention ingestion is not ready.",
        blockers: config.blockers,
      },
      503,
    );
  }
  const accountId = process.env.X_EXPECTED_ACCOUNT_ID;
  if (!accountId || !X_ACCOUNT_ID.test(accountId)) {
    return response({ error: "The bound X account identity is invalid." }, 503);
  }

  let discovery;
  try {
    discovery = await discoverMentions(accountId, config.autoReplyReady);
  } catch {
    return response(
      {
        error:
          "X mention discovery could not be completed; no automatic reply was attempted.",
      },
      503,
    );
  }
  if ("skipped" in discovery) {
    return response({
      skipped: true,
      reason: discovery.skipped === "leased"
        ? "Another X mention poll owns the lease."
        : discovery.skipped === "compliance_hold"
          ? "X mention ingestion is paused for compliance verification."
          : "The next X mention poll is not due.",
      providerWritesAttempted: false,
    });
  }
  if (!discovery.completed) {
    return response(
      {
        discovery,
        error:
          "The bounded mention page limit was reached; a stable continuation checkpoint was retained and no reply was attempted.",
        providerWritesAttempted: false,
      },
      503,
    );
  }
  if (discovery.baseline) {
    return response({
      discovery,
      replyStatus: "baseline_only",
      providerWritesAttempted: false,
    });
  }
  if (!config.autoReplyReady) {
    return response({
      discovery,
      replyStatus: "review_only",
      autoReplyBlockers: config.blockers,
      providerWritesAttempted: false,
    });
  }

  const marketing = readMarketingConfig();
  const effectiveDailyCap = Math.min(
    config.dailyCap,
    marketing.dailyCaps.xReplies,
  );
  if (effectiveDailyCap < 1) {
    return response({
      discovery,
      replyStatus: "daily_cap_reached",
      providerWritesAttempted: false,
    });
  }
  try {
    const reply = await deliverOneReply(accountId, effectiveDailyCap);
    return response({ discovery, ...reply });
  } catch {
    return response(
      {
        discovery,
        error:
          "X reply processing failed closed; no automatic retry was scheduled.",
      },
      503,
    );
  }
}
