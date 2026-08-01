import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(() => true),
  fetchPage: vi.fn(),
  postReply: vi.fn(),
  verifyMention: vi.fn(),
  ledgerSnapshot: vi.fn(),
  claimDelivery: vi.fn(),
  completeDelivery: vi.fn(),
  storeConfigured: vi.fn(() => true),
  claimLease: vi.fn(),
  commitDiscovery: vi.fn(),
  deferPoll: vi.fn(),
  claimMention: vi.fn(),
  completeMention: vi.fn(),
  failMention: vi.fn(),
}));

vi.mock("@/lib/cron-auth", () => ({
  isCronAuthorized: mocks.authorized,
}));
vi.mock("@/lib/marketing/channels", async () => {
  const actual = await vi.importActual<typeof import("@/lib/marketing/channels")>(
    "@/lib/marketing/channels",
  );
  return {
    ...actual,
    fetchXMentionsPage: mocks.fetchPage,
    postXDeterministicMentionReply: mocks.postReply,
    verifyXMentionById: mocks.verifyMention,
  };
});
vi.mock("@/lib/marketing/ledger-server", () => ({
  getMarketingLedgerSnapshot: mocks.ledgerSnapshot,
  claimMarketingDelivery: mocks.claimDelivery,
  completeMarketingDeliveryClaim: mocks.completeDelivery,
}));
vi.mock("@/lib/marketing/x-mentions-server", () => ({
  marketingXMentionsConfigured: mocks.storeConfigured,
  claimXMentionPollLease: mocks.claimLease,
  commitXMentionDiscovery: mocks.commitDiscovery,
  deferXMentionPoll: mocks.deferPoll,
  claimNextEligibleXMention: mocks.claimMention,
  completeXMentionReply: mocks.completeMention,
  failXMentionReply: mocks.failMention,
}));

import {
  xMentionContentHash,
  X_MENTION_TEMPLATE_REGISTRY_DIGEST,
} from "@/lib/marketing/x-mentions";

import { GET } from "./route";

function request(): Request {
  return new Request("https://www.0xzaps.com/api/marketing/x/mentions/cron", {
    headers: { authorization: "Bearer cron" },
  });
}

function observation(text = "@0xzaps /docs") {
  return {
    id: "123456789",
    authorId: "200",
    conversationId: "123456789",
    text,
    createdAt: new Date().toISOString(),
    possiblySensitive: false,
    authorProtected: false,
    isWithheld: false,
    hasMedia: false,
    hasExternalLink: false,
    isRepost: false,
  };
}

function readyEnvironment(): void {
  vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "false");
  vi.stubEnv("OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_SUPABASE_PROJECT_REF", "abcdefghijklmnopqrst");
  vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED", "true");
  vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
  vi.stubEnv("X_EXPECTED_USERNAME", "0xzaps");
  vi.stubEnv("X_USER_ACCESS_TOKEN", "user-token");
  vi.stubEnv("OPENZAPS_X_MENTION_HASH_SECRET", "h".repeat(32));
  vi.stubEnv("OPENZAPS_X_MENTION_INGEST_ENABLED", "true");
  vi.stubEnv("OPENZAPS_X_COMMERCIAL_USE_APPROVED", "true");
  vi.stubEnv("OPENZAPS_X_COMPLIANCE_READY", "true");
  vi.stubEnv("OPENZAPS_X_AUTO_REPLY_ENABLED", "true");
  vi.stubEnv("OPENZAPS_X_AUTO_RESPONSE_APPROVED", "true");
  vi.stubEnv(
    "OPENZAPS_X_AUTO_RESPONSE_APPROVAL_DIGEST",
    X_MENTION_TEMPLATE_REGISTRY_DIGEST,
  );
  vi.stubEnv("OPENZAPS_X_AUTO_REPLY_DAILY_CAP", "1");
  vi.stubEnv("OPENZAPS_MARKETING_DAILY_X_REPLY_CAP", "10");
}

beforeEach(() => {
  readyEnvironment();
  mocks.authorized.mockReturnValue(true);
  mocks.storeConfigured.mockReturnValue(true);
  mocks.claimLease.mockResolvedValue({
    result: "claimed",
    accountId: "100",
    leaseToken: "00000000-0000-4000-8000-000000000001",
    sinceId: "100",
    continuationUntilId: null,
    continuationBaseSinceId: null,
    continuationNewestId: null,
    baselineRequired: false,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    nextPollAt: new Date().toISOString(),
    lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
  });
  mocks.fetchPage.mockResolvedValue({
    authenticatedAccountId: "100",
    authenticatedUsername: "0xzaps",
    mentions: [observation()],
    newestId: "123456789",
    oldestId: "123456789",
    nextToken: null,
  });
  mocks.commitDiscovery.mockResolvedValue({
    result: "committed",
    accountId: "100",
    insertedCount: 1,
    existingCount: 0,
    optOutCount: 0,
    sinceId: "123456789",
    continuationUntilId: null,
    continuationNewestId: null,
    initializedAt: new Date().toISOString(),
    nextPollAt: new Date(Date.now() + 60_000).toISOString(),
    lastSuccessAt: new Date().toISOString(),
  });
  mocks.ledgerSnapshot.mockResolvedValue({
    source: "durable",
    usage: {
      day: new Date().toISOString().slice(0, 10),
      counts: {
        xPosts: 0,
        xReplies: 0,
        discordPosts: 0,
        substackTutorials: 0,
        directMessages: 0,
      },
    },
    repliedInteractionIds: [],
  });
  mocks.claimMention.mockResolvedValue({ result: "no_eligible", mention: null });
  mocks.deferPoll.mockResolvedValue({ result: "deferred" });
  mocks.failMention.mockResolvedValue({ result: "failed" });
  mocks.completeMention.mockResolvedValue({ result: "completed" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("X mentions cron", () => {
  it("rejects an unauthorized invocation before provider or database work", async () => {
    mocks.authorized.mockReturnValue(false);
    const result = await GET(request());
    expect(result.status).toBe(401);
    expect(mocks.claimLease).not.toHaveBeenCalled();
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it("baselines the first successful snapshot without replying", async () => {
    mocks.claimLease.mockResolvedValue({
      ...await mocks.claimLease(),
      baselineRequired: true,
      sinceId: null,
    });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      replyStatus: "baseline_only",
      providerWritesAttempted: false,
      discovery: { baseline: true, completed: true },
    });
    expect(mocks.claimMention).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();
  });

  it("initializes an empty first baseline without replying", async () => {
    mocks.claimLease.mockResolvedValue({
      ...await mocks.claimLease(),
      baselineRequired: true,
      sinceId: null,
    });
    mocks.fetchPage.mockResolvedValue({
      authenticatedAccountId: "100",
      authenticatedUsername: "0xzaps",
      mentions: [],
      newestId: null,
      oldestId: null,
      nextToken: null,
    });
    mocks.commitDiscovery.mockResolvedValue({
      result: "baseline_empty",
      accountId: "100",
      insertedCount: 0,
      existingCount: 0,
      optOutCount: 0,
      sinceId: null,
      continuationUntilId: null,
      continuationNewestId: null,
      initializedAt: new Date().toISOString(),
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: new Date().toISOString(),
    });

    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      replyStatus: "baseline_only",
      providerWritesAttempted: false,
      discovery: {
        insertedCount: 0,
        baseline: true,
        completed: true,
      },
    });
    expect(mocks.commitDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      previousSinceId: null,
      nextSinceId: null,
      previousContinuationUntilId: null,
      nextContinuationUntilId: null,
      completed: true,
      mentions: [],
    }));
    expect(mocks.claimMention).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();
  });

  it("honors a compliance hold without provider reads or writes", async () => {
    mocks.claimLease.mockResolvedValue({
      result: "compliance_hold",
      accountId: "100",
      leaseToken: null,
      sinceId: "100",
      continuationUntilId: null,
      continuationBaseSinceId: null,
      continuationNewestId: null,
      baselineRequired: false,
      leaseExpiresAt: null,
      nextPollAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
    });

    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      skipped: true,
      reason: "X mention ingestion is paused for compliance verification.",
      providerWritesAttempted: false,
    });
    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(mocks.commitDiscovery).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();
  });

  it("keeps discovery review-only when the separate X campaign approval is absent", async () => {
    vi.stubEnv("OPENZAPS_X_AUTO_RESPONSE_APPROVED", "false");
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      replyStatus: "review_only",
      providerWritesAttempted: false,
    });
    expect(mocks.commitDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      mentions: [expect.objectContaining({
        classification: "review",
        eligibilityReason: "auto_reply_not_ready",
      })],
    }));
    expect(mocks.claimMention).not.toHaveBeenCalled();
  });

  it("does not persist protected or withheld mention observations", async () => {
    const visible = { ...observation(), id: "400", conversationId: "400" };
    const protectedMention = {
      ...observation(),
      id: "300",
      conversationId: "300",
      authorProtected: true,
    };
    const withheldMention = {
      ...observation(),
      id: "200",
      conversationId: "200",
      isWithheld: true,
    };
    mocks.fetchPage.mockResolvedValue({
      authenticatedAccountId: "100",
      authenticatedUsername: "0xzaps",
      mentions: [visible, protectedMention, withheldMention],
      newestId: "400",
      oldestId: "200",
      nextToken: null,
    });

    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(mocks.commitDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      mentions: [expect.objectContaining({ postId: "400" })],
    }));
    const [commit] = mocks.commitDiscovery.mock.calls[0] as [{
      mentions: Array<{ postId: string }>;
    }];
    expect(commit.mentions.map((mention) => mention.postId)).toEqual(["400"]);
  });

  it("publishes exactly one non-AI reviewed reply after revalidation and both durable claims", async () => {
    const mention = observation();
    mocks.claimMention.mockResolvedValue({
      result: "claimed",
      mention: {
        accountId: "100",
        postId: mention.id,
        authorId: mention.authorId,
        conversationId: mention.conversationId,
        createdAt: mention.createdAt,
        contentHmac: xMentionContentHash(mention.text, "h".repeat(32)),
        deliveryReference: "22222222-2222-4222-8222-222222222222",
        interactionReference: "1".repeat(30),
        classification: "auto_reply",
        eligibilityReason: "template:docs-v1",
        claimToken: "00000000-0000-4000-8000-000000000002",
        claimDay: new Date().toISOString().slice(0, 10),
        claimedAt: new Date().toISOString(),
      },
    });
    mocks.verifyMention.mockResolvedValue({
      authenticatedAccountId: "100",
      authenticatedUsername: "0xzaps",
      mention,
    });
    mocks.claimDelivery.mockResolvedValue({
      result: "claimed",
      status: "claimed",
    });
    mocks.postReply.mockResolvedValue({
      providerMessageId: "987654321",
      providerUrl: "https://x.com/i/web/status/987654321",
    });
    mocks.completeDelivery.mockResolvedValue({
      result: "finalized",
      status: "published",
    });

    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ replyStatus: "published" });
    expect(mocks.claimDelivery).toHaveBeenCalledWith(expect.objectContaining({
      channel: "x",
      action: "reply",
      interactionId: mention.id,
      dailyCap: 1,
    }));
    expect(mocks.postReply).toHaveBeenCalledTimes(1);
    expect(mocks.postReply).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "docs-v1",
      inReplyToTweetId: mention.id,
      authenticatedAccountId: "100",
    }), expect.any(Object));
    expect(mocks.completeMention).toHaveBeenCalledTimes(1);
  });

  it("fails the claimed mention without delivery when its text or exact template changes", async () => {
    const original = observation();
    mocks.claimMention.mockResolvedValue({
      result: "claimed",
      mention: {
        accountId: "100",
        postId: original.id,
        authorId: original.authorId,
        conversationId: original.conversationId,
        createdAt: original.createdAt,
        contentHmac: xMentionContentHash(original.text, "h".repeat(32)),
        deliveryReference: "33333333-3333-4333-8333-333333333333",
        interactionReference: "2".repeat(30),
        classification: "auto_reply",
        eligibilityReason: "template:docs-v1",
        claimToken: "00000000-0000-4000-8000-000000000003",
        claimDay: new Date().toISOString().slice(0, 10),
        claimedAt: new Date().toISOString(),
      },
    });
    mocks.verifyMention.mockResolvedValue({
      authenticatedAccountId: "100",
      authenticatedUsername: "0xzaps",
      mention: observation("@0xzaps what is OpenZaps?"),
    });

    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      replyStatus: "blocked",
      reason: "content_or_policy_changed",
    });
    expect(mocks.failMention).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "content_or_policy_changed",
    }));
    expect(mocks.claimDelivery).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();
  });

  it.each(["conversation", "created_at"] as const)(
    "blocks delivery when the revalidated %s changes",
    async (changedField) => {
      const original = observation();
      mocks.claimMention.mockResolvedValue({
        result: "claimed",
        mention: {
          accountId: "100",
          postId: original.id,
          authorId: original.authorId,
          conversationId: original.conversationId,
          createdAt: original.createdAt,
          contentHmac: xMentionContentHash(original.text, "h".repeat(32)),
          deliveryReference: "44444444-4444-4444-8444-444444444444",
          interactionReference: "3".repeat(30),
          classification: "auto_reply",
          eligibilityReason: "template:docs-v1",
          claimToken: "00000000-0000-4000-8000-000000000004",
          claimDay: new Date().toISOString().slice(0, 10),
          claimedAt: new Date().toISOString(),
        },
      });
      mocks.verifyMention.mockResolvedValue({
        authenticatedAccountId: "100",
        authenticatedUsername: "0xzaps",
        mention: changedField === "conversation"
          ? { ...original, conversationId: "987654321" }
          : {
              ...original,
              createdAt: new Date(Date.parse(original.createdAt) + 1_000)
                .toISOString(),
            },
      });

      const result = await GET(request());
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        replyStatus: "blocked",
        reason: "content_or_policy_changed",
      });
      expect(mocks.failMention).toHaveBeenCalledWith(expect.objectContaining({
        failureCode: "content_or_policy_changed",
      }));
      expect(mocks.claimDelivery).not.toHaveBeenCalled();
      expect(mocks.postReply).not.toHaveBeenCalled();
    },
  );

  it("retains and resumes a stable first-run baseline after the five-page limit", async () => {
    const firstLease = {
      ...await mocks.claimLease(),
      sinceId: null,
      continuationUntilId: null,
      continuationBaseSinceId: null,
      continuationNewestId: null,
      baselineRequired: true,
      lastSuccessAt: null,
    };
    const secondLease = {
      ...firstLease,
      leaseToken: "00000000-0000-4000-8000-000000000005",
      continuationUntilId: "200",
      continuationBaseSinceId: null,
      continuationNewestId: "600",
    };
    mocks.claimLease
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(secondLease);

    const pageIds = ["600", "500", "400", "300", "200", "100"];
    mocks.fetchPage.mockImplementation(async () => {
      const id = pageIds[mocks.fetchPage.mock.calls.length - 1];
      if (!id) throw new Error("unexpected page");
      return {
        authenticatedAccountId: "100",
        authenticatedUsername: "0xzaps",
        mentions: [{ ...observation(), id, conversationId: id }],
        newestId: id,
        oldestId: id,
        nextToken: id === "100" ? null : `after-${id}`,
      };
    });
    mocks.commitDiscovery
      .mockResolvedValueOnce({
        result: "partial_committed",
        accountId: "100",
        insertedCount: 5,
        existingCount: 0,
        optOutCount: 0,
        sinceId: null,
        continuationUntilId: "200",
        continuationNewestId: "600",
        initializedAt: null,
        nextPollAt: new Date(Date.now() + 60_000).toISOString(),
        lastSuccessAt: null,
      })
      .mockResolvedValueOnce({
        result: "committed",
        accountId: "100",
        insertedCount: 1,
        existingCount: 0,
        optOutCount: 0,
        sinceId: "600",
        continuationUntilId: null,
        continuationNewestId: null,
        initializedAt: new Date().toISOString(),
        nextPollAt: new Date(Date.now() + 60_000).toISOString(),
        lastSuccessAt: new Date().toISOString(),
      });

    const partial = await GET(request());
    expect(partial.status).toBe(503);
    expect(mocks.fetchPage).toHaveBeenCalledTimes(5);
    expect(mocks.commitDiscovery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        previousSinceId: null,
        nextSinceId: "600",
        previousContinuationUntilId: null,
        nextContinuationUntilId: "200",
        completed: false,
      }),
    );
    expect(mocks.claimMention).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();

    const completed = await GET(request());
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      replyStatus: "baseline_only",
      providerWritesAttempted: false,
      discovery: { baseline: true, completed: true },
    });
    expect(mocks.fetchPage).toHaveBeenLastCalledWith(
      {
        untilId: "200",
        maxResults: 100,
      },
      { requestTimeoutMs: 8_000 },
    );
    expect(mocks.commitDiscovery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        previousSinceId: null,
        nextSinceId: "600",
        previousContinuationUntilId: "200",
        nextContinuationUntilId: null,
        completed: true,
      }),
    );
    expect(mocks.claimMention).not.toHaveBeenCalled();
    expect(mocks.postReply).not.toHaveBeenCalled();
  });
});
