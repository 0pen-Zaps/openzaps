import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  claimNextEligibleXMention,
  claimXMentionPollLease,
  commitXMentionDiscovery,
  completeXMentionReply,
  deferXMentionPoll,
  failXMentionReply,
  listXMentionInbox,
  marketingXMentionsConfigured,
  recordXMentionOptOut,
  XMentionStoreError,
} from "@/lib/marketing/x-mentions-server";

const ENV = {
  OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
  OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
} as const;

const ACCOUNT_ID = "100";
const POST_ID = "200";
const AUTHOR_ID = "300";
const CONVERSATION_ID = "400";
const TOKEN = "11111111-1111-4111-8111-111111111111";
const DELIVERY_REFERENCE = "22222222-2222-4222-8222-222222222222";
const INTERACTION_REFERENCE = "1".repeat(30);
const HMAC = "ab".repeat(32);

function responseRow(row: Record<string, unknown>): Response {
  return Response.json([row]);
}

describe("durable X mention configuration", () => {
  it("requires the explicit gate, service role, and exact bound Supabase origin", () => {
    expect(marketingXMentionsConfigured(ENV)).toBe(true);
    expect(marketingXMentionsConfigured({
      ...ENV,
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "false",
    })).toBe(false);
    expect(marketingXMentionsConfigured({
      ...ENV,
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "anotherprojectref",
    })).toBe(false);
    expect(marketingXMentionsConfigured({
      ...ENV,
      SUPABASE_URL: "https://api.abcdefghijklmnopqrst.supabase.co",
    })).toBe(false);
    expect(marketingXMentionsConfigured({
      ...ENV,
      SUPABASE_SERVICE_ROLE_KEY: "bad\nsecret",
    })).toBe(false);
    expect(marketingXMentionsConfigured({
      ...ENV,
      SUPABASE_URL: "http://127.0.0.1:54321",
    })).toBe(true);
    expect(marketingXMentionsConfigured({
      ...ENV,
      NODE_ENV: "production",
      SUPABASE_URL: "http://127.0.0.1:54321",
    })).toBe(false);
  });
});

describe("claimXMentionPollLease", () => {
  it("claims an account-bound first-run lease through the service-role RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "claimed",
      account_id: ACCOUNT_ID,
      lease_token: TOKEN,
      since_id: null,
      continuation_until_id: null,
      continuation_base_since_id: null,
      continuation_newest_id: null,
      baseline_required: true,
      lease_expires_at: "2026-08-01T15:02:00.000Z",
      next_poll_at: "2026-08-01T15:00:00.000Z",
      last_success_at: null,
    }));

    await expect(claimXMentionPollLease(ACCOUNT_ID, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      result: "claimed",
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      sinceId: null,
      continuationUntilId: null,
      continuationBaseSinceId: null,
      continuationNewestId: null,
      baselineRequired: true,
      leaseExpiresAt: "2026-08-01T15:02:00.000Z",
      nextPollAt: "2026-08-01T15:00:00.000Z",
      lastSuccessAt: null,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/claim_marketing_x_mention_poll",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ p_account_id: ACCOUNT_ID }),
    });
    expect(init.headers).toMatchObject({
      apikey: "service-secret",
      authorization: "Bearer service-secret",
    });
  });

  it("returns a compliance hold without issuing a poll lease", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "compliance_hold",
      account_id: ACCOUNT_ID,
      lease_token: null,
      since_id: POST_ID,
      continuation_until_id: null,
      continuation_base_since_id: null,
      continuation_newest_id: null,
      baseline_required: false,
      lease_expires_at: null,
      next_poll_at: "2026-08-01T15:00:00.000Z",
      last_success_at: "2026-08-01T14:59:00.000Z",
    }));

    await expect(claimXMentionPollLease(ACCOUNT_ID, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      result: "compliance_hold",
      accountId: ACCOUNT_ID,
      leaseToken: null,
      sinceId: POST_ID,
      continuationUntilId: null,
      continuationBaseSinceId: null,
      continuationNewestId: null,
      baselineRequired: false,
      leaseExpiresAt: null,
      nextPollAt: "2026-08-01T15:00:00.000Z",
      lastSuccessAt: "2026-08-01T14:59:00.000Z",
    });
  });
});

describe("commitXMentionDiscovery", () => {
  it("sends only metadata fields and represents an explicit complete-page commit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "committed",
      account_id: ACCOUNT_ID,
      inserted_count: 1,
      existing_count: 0,
      opt_out_count: 0,
      resulting_since_id: POST_ID,
      continuation_until_id: null,
      continuation_newest_id: null,
      initialized_at: "2026-08-01T15:00:05.000Z",
      next_poll_at: "2026-08-01T15:01:05.000Z",
      last_success_at: "2026-08-01T15:00:05.000Z",
    }));

    await expect(commitXMentionDiscovery({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      previousSinceId: null,
      nextSinceId: POST_ID,
      previousContinuationUntilId: null,
      nextContinuationUntilId: null,
      completed: true,
      mentions: [{
        postId: POST_ID,
        authorId: AUTHOR_ID,
        conversationId: CONVERSATION_ID,
        createdAt: "2026-08-01T14:59:00-00:00",
        contentHmac: HMAC,
        classification: "auto_reply",
        eligibilityReason: "bounded_faq",
        // Runtime callers cannot smuggle raw text through normalization.
        text: "do not persist",
        deliveryReference: DELIVERY_REFERENCE,
        interactionReference: INTERACTION_REFERENCE,
      } as never],
    }, { env: ENV, fetchImpl: fetchMock })).resolves.toMatchObject({
      result: "committed",
      sinceId: POST_ID,
      insertedCount: 1,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      p_account_id: ACCOUNT_ID,
      p_lease_token: TOKEN,
      p_previous_since_id: null,
      p_next_since_id: POST_ID,
      p_previous_continuation_until_id: null,
      p_next_continuation_until_id: null,
      p_completed: true,
    });
    expect(body.p_mentions).toEqual([{
      post_id: POST_ID,
      author_id: AUTHOR_ID,
      conversation_id: CONVERSATION_ID,
      created_at: "2026-08-01T14:59:00.000Z",
      content_hmac: HMAC,
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
    }]);
    expect(JSON.stringify(body)).not.toContain("do not persist");
    expect(JSON.stringify(body)).not.toContain(DELIVERY_REFERENCE);
    expect(JSON.stringify(body)).not.toContain(INTERACTION_REFERENCE);
  });

  it("accepts an empty completed baseline as initialized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "baseline_empty",
      account_id: ACCOUNT_ID,
      inserted_count: 0,
      existing_count: 0,
      opt_out_count: 0,
      resulting_since_id: null,
      continuation_until_id: null,
      continuation_newest_id: null,
      initialized_at: "2026-08-01T15:00:05.000Z",
      next_poll_at: "2026-08-01T15:01:05.000Z",
      last_success_at: "2026-08-01T15:00:05.000Z",
    }));

    await expect(commitXMentionDiscovery({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      previousSinceId: null,
      nextSinceId: null,
      previousContinuationUntilId: null,
      nextContinuationUntilId: null,
      completed: true,
      mentions: [],
    }, { env: ENV, fetchImpl: fetchMock })).resolves.toMatchObject({
      result: "baseline_empty",
      sinceId: null,
      continuationUntilId: null,
      initializedAt: "2026-08-01T15:00:05.000Z",
      lastSuccessAt: "2026-08-01T15:00:05.000Z",
    });
  });

  it("accepts at most five complete 100-result pages and rejects duplicates locally", async () => {
    const mention = (index: number) => ({
      postId: String(1_000 + index),
      authorId: String(2_000 + index),
      conversationId: String(3_000 + index),
      createdAt: "2026-08-01T14:59:00.000Z",
      contentHmac: HMAC,
      classification: "review" as const,
      eligibilityReason: "needs_review",
    });
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "partial_committed",
      account_id: ACCOUNT_ID,
      inserted_count: 500,
      existing_count: 0,
      opt_out_count: 0,
      resulting_since_id: null,
      continuation_until_id: "1000",
      continuation_newest_id: "1499",
      initialized_at: null,
      next_poll_at: "2026-08-01T15:00:15.000Z",
      last_success_at: null,
    }));

    await expect(commitXMentionDiscovery({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      previousSinceId: null,
      nextSinceId: "1499",
      previousContinuationUntilId: null,
      nextContinuationUntilId: "1000",
      completed: false,
      mentions: Array.from({ length: 500 }, (_, index) => mention(index)),
    }, { env: ENV, fetchImpl: fetchMock })).resolves.toMatchObject({
      result: "partial_committed",
      sinceId: null,
      lastSuccessAt: null,
    });

    await expect(commitXMentionDiscovery({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      previousSinceId: null,
      nextSinceId: null,
      previousContinuationUntilId: null,
      nextContinuationUntilId: null,
      completed: false,
      mentions: Array.from({ length: 501 }, (_, index) => mention(index)),
    }, { env: ENV, fetchImpl: vi.fn() })).rejects.toMatchObject({
      code: "invalid_input",
    });

    await expect(commitXMentionDiscovery({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      previousSinceId: null,
      nextSinceId: null,
      previousContinuationUntilId: null,
      nextContinuationUntilId: null,
      completed: false,
      mentions: [mention(1), mention(1)],
    }, { env: ENV, fetchImpl: vi.fn() })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("poll deferral and inbox listing", () => {
  it("releases a lease into a bounded machine-coded deferral", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "deferred",
      account_id: ACCOUNT_ID,
      next_poll_at: "2026-08-01T15:15:00.000Z",
      last_success_at: "2026-08-01T14:55:00.000Z",
      defer_reason: "x_rate_limited",
      deferred_at: "2026-08-01T15:00:00.000Z",
    }));

    await expect(deferXMentionPoll({
      accountId: ACCOUNT_ID,
      leaseToken: TOKEN,
      nextPollAt: "2026-08-01T15:15:00.000Z",
      reason: "x_rate_limited",
    }, { env: ENV, fetchImpl: fetchMock })).resolves.toMatchObject({
      result: "deferred",
      reason: "x_rate_limited",
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      p_account_id: ACCOUNT_ID,
      p_lease_token: TOKEN,
      p_next_poll_at: "2026-08-01T15:15:00.000Z",
      p_reason: "x_rate_limited",
    });
  });

  it("lists only bounded metadata with the exact review count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "listed",
      account_id: ACCOUNT_ID,
      review_required_count: 1,
      items: [{
        post_id: POST_ID,
        author_id: AUTHOR_ID,
        conversation_id: CONVERSATION_ID,
        created_at: "2026-08-01T14:59:00.000Z",
        content_hmac: HMAC,
        classification: "review",
        eligibility_reason: "needs_review",
        state: "review_required",
        discovered_at: "2026-08-01T15:00:00.000Z",
        state_changed_at: "2026-08-01T15:00:00.000Z",
        claim_day: null,
        claimed_at: null,
        replied_at: null,
        failed_at: null,
        failure_code: null,
      }],
    }));

    await expect(listXMentionInbox({ accountId: ACCOUNT_ID, limit: 20 }, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({
      result: "listed",
      reviewRequiredCount: 1,
      items: [{
        postId: POST_ID,
        authorId: AUTHOR_ID,
        state: "review_required",
      }],
    });
  });
});

describe("reply admission and terminal state", () => {
  it("passes a strict 0..5 daily cap before terminally claiming a mention", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "claimed",
      account_id: ACCOUNT_ID,
      post_id: POST_ID,
      author_id: AUTHOR_ID,
      conversation_id: CONVERSATION_ID,
      source_created_at: "2026-08-01T14:59:00.000Z",
      content_hmac: HMAC,
      classification: "auto_reply",
      eligibility_reason: "bounded_faq",
      state: "claimed",
      delivery_reference: DELIVERY_REFERENCE,
      interaction_reference: INTERACTION_REFERENCE,
      claim_token: TOKEN,
      claim_day: "2026-08-01",
      claimed_at: "2026-08-01T15:00:00.000Z",
    }));

    await expect(claimNextEligibleXMention(ACCOUNT_ID, 2, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({
      result: "claimed",
      claimDay: "2026-08-01",
      mention: {
        postId: POST_ID,
        deliveryReference: DELIVERY_REFERENCE,
        interactionReference: INTERACTION_REFERENCE,
        claimToken: TOKEN,
      },
    });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.body).toBe(JSON.stringify({
      p_account_id: ACCOUNT_ID,
      p_daily_cap: 2,
    }));

    await expect(claimNextEligibleXMention(ACCOUNT_ID, 6, {
      env: ENV,
      fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("recognizes the database daily-cap result without consuming an item", async () => {
    await expect(claimNextEligibleXMention(ACCOUNT_ID, 1, {
      env: ENV,
      fetchImpl: vi.fn().mockResolvedValue(responseRow({
        result_code: "daily_cap_reached",
        account_id: ACCOUNT_ID,
        post_id: null,
        author_id: null,
        conversation_id: null,
        source_created_at: null,
        content_hmac: null,
        classification: null,
        eligibility_reason: null,
        state: null,
        delivery_reference: null,
        interaction_reference: null,
        claim_token: null,
        claim_day: "2026-08-01",
        claimed_at: null,
      })),
    })).resolves.toEqual({
      result: "daily_cap_reached",
      mention: null,
      claimDay: "2026-08-01",
    });
  });

  it("completes or fails only the exact durable claim", async () => {
    await expect(completeXMentionReply({
      accountId: ACCOUNT_ID,
      postId: POST_ID,
      claimToken: TOKEN,
    }, {
      env: ENV,
      fetchImpl: vi.fn().mockResolvedValue(responseRow({
        result_code: "completed",
        account_id: ACCOUNT_ID,
        post_id: POST_ID,
        state: "replied",
        completed_at: "2026-08-01T15:01:00.000Z",
      })),
    })).resolves.toMatchObject({ result: "completed", state: "replied" });

    await expect(failXMentionReply({
      accountId: ACCOUNT_ID,
      postId: POST_ID,
      claimToken: TOKEN,
      failureCode: "provider_ambiguous",
    }, {
      env: ENV,
      fetchImpl: vi.fn().mockResolvedValue(responseRow({
        result_code: "failed",
        account_id: ACCOUNT_ID,
        post_id: POST_ID,
        state: "failed",
        failed_at: "2026-08-01T15:01:00.000Z",
      })),
    })).resolves.toMatchObject({ result: "failed", state: "failed" });
  });

  it("records an author-id opt-out without accepting profile data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow({
      result_code: "recorded",
      account_id: ACCOUNT_ID,
      author_id: AUTHOR_ID,
      source_post_id: POST_ID,
      opted_out_at: "2026-08-01T15:00:00.000Z",
      blocked_count: 2,
    }));
    await expect(recordXMentionOptOut({
      accountId: ACCOUNT_ID,
      authorId: AUTHOR_ID,
      sourcePostId: POST_ID,
    }, { env: ENV, fetchImpl: fetchMock })).resolves.toMatchObject({
      result: "recorded",
      blockedCount: 2,
    });
  });
});

describe("fail-closed transport", () => {
  it("does not call Supabase without configuration or leak a rejected secret", async () => {
    const fetchMock = vi.fn();
    await expect(claimXMentionPollLease(ACCOUNT_ID, {
      env: {},
      fetchImpl: fetchMock,
    })).rejects.toEqual(expect.objectContaining<Partial<XMentionStoreError>>({
      code: "not_configured",
    }));
    expect(fetchMock).not.toHaveBeenCalled();

    const secret = ENV.SUPABASE_SERVICE_ROLE_KEY;
    let thrown: unknown;
    try {
      await claimXMentionPollLease(ACCOUNT_ID, {
        env: ENV,
        fetchImpl: vi.fn().mockRejectedValue(new Error(`leaked ${secret}`)),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "network_error" });
    expect((thrown as Error).message).not.toContain(secret);
  });
});
