import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  claimNextReviewedMarketingCampaign,
  claimMarketingScheduleSlot,
  MarketingLedgerError,
  claimMarketingDelivery,
  completeMarketingDeliveryClaim,
  emptyDryRunMarketingLedgerSnapshot,
  getMarketingLedgerSnapshot,
  marketingLedgerConfigured,
  verifyReviewedMarketingCampaignClaim,
} from "@/lib/marketing/ledger-server";
import { reviewedMarketingCampaign } from "@/lib/marketing/scheduled-template";

const ENV = {
  OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
  OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
} as const;

function responseRow(row: Record<string, unknown>): Response {
  return Response.json([row]);
}

function claimResponse(overrides: Record<string, unknown> = {}): Response {
  return responseRow({
    result_code: "claimed",
    resulting_status: "claimed",
    current_count: 1,
    resulting_day: "2026-07-29",
    provider_message_id: null,
    provider_url: null,
    failure_code: null,
    claimed_at: "2026-07-29T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  });
}

function campaignQueueResponse(
  overrides: Record<string, unknown> = {},
): Response {
  const campaign = reviewedMarketingCampaign(
    "virtual-trading-request-zap-v2",
    "discord",
  );
  return responseRow({
    result_code: "claimed",
    schedule_key: "weekday_product_update",
    slot_day: "2026-07-29",
    campaign_id: campaign.id,
    channel: campaign.channel,
    queue_order: campaign.queueOrder,
    not_before: campaign.notBefore,
    body: campaign.body,
    links: campaign.links,
    topics: campaign.topics,
    disclosures: campaign.disclosures,
    claims: campaign.claims,
    flags: campaign.flags,
    required_facts: campaign.requiredFacts,
    canonical_source_urls: campaign.canonicalSourceUrls,
    content_hash: campaign.contentHash,
    claimed_at: "2026-07-29T14:00:00.000Z",
    ...overrides,
  });
}

describe("marketing delivery ledger configuration", () => {
  it("requires an explicit gate, a valid Supabase origin, and a server secret", () => {
    expect(marketingLedgerConfigured(ENV)).toBe(true);
    expect(marketingLedgerConfigured({ ...ENV, OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "false" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "https://user:pass@abcdefghijklmnopqrst.supabase.co" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co/rest/v1" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "https://ledger.example" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "https://api.abcdefghijklmnopqrst.supabase.co" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "http://project.supabase.co" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "anotherprojectref" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: undefined })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_URL: "http://127.0.0.1:54321" })).toBe(true);
    expect(marketingLedgerConfigured({ ...ENV, NODE_ENV: "production", SUPABASE_URL: "http://127.0.0.1:54321" })).toBe(false);
    expect(marketingLedgerConfigured({ ...ENV, SUPABASE_SERVICE_ROLE_KEY: " \nsecret" })).toBe(false);
  });

  it("creates an explicitly marked empty snapshot only for side-effect-free dry runs", () => {
    expect(emptyDryRunMarketingLedgerSnapshot("2026-07-29")).toEqual({
      source: "dry_run_empty",
      usage: {
        day: "2026-07-29",
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
    expect(() => emptyDryRunMarketingLedgerSnapshot("2026-02-30")).toThrow("valid UTC date");
  });
});

describe("getMarketingLedgerSnapshot", () => {
  it("reads current durable counters and only requested replied interactions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseRow({
        snapshot_day: "2026-07-29",
        x_posts: 2,
        x_replies: 3,
        discord_posts: 1,
        substack_tutorials: 1,
        direct_messages: 0,
        replied_interaction_ids: ["100", "101", "100"],
      }),
    );

    await expect(
      getMarketingLedgerSnapshot(["100", "101", "100"], { env: ENV, fetchImpl: fetchMock }),
    ).resolves.toEqual({
      source: "durable",
      usage: {
        day: "2026-07-29",
        counts: {
          xPosts: 2,
          xReplies: 3,
          discordPosts: 1,
          substackTutorials: 1,
          directMessages: 0,
        },
      },
      repliedInteractionIds: ["100", "101"],
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/get_marketing_delivery_snapshot",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ p_interaction_ids: ["100", "101"] }),
    });
    expect(init.headers).toMatchObject({
      apikey: "service-secret",
      authorization: "Bearer service-secret",
    });
  });

  it("rejects invalid request IDs and malformed or oversized streamed responses", async () => {
    const fetchMock = vi.fn();
    await expect(
      getMarketingLedgerSnapshot(["not-a-post"], { env: ENV, fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      getMarketingLedgerSnapshot([], {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(Response.json([{ snapshot_day: "not-a-day" }])),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`[{"snapshot_day":"2026-07-29","padding":"`));
        controller.enqueue(new Uint8Array(70_000).fill(97));
        controller.enqueue(new TextEncoder().encode('"}]'));
        controller.close();
      },
    });
    await expect(
      getMarketingLedgerSnapshot([], {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(new Response(oversizedBody)),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("fails closed without configuration or when the RPC cannot be reached", async () => {
    const fetchMock = vi.fn();
    await expect(
      getMarketingLedgerSnapshot([], { env: {}, fetchImpl: fetchMock }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<MarketingLedgerError>>({
        code: "not-configured",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const secret = ENV.SUPABASE_SERVICE_ROLE_KEY;
    let thrown: unknown;
    try {
      await getMarketingLedgerSnapshot([], {
        env: ENV,
        fetchImpl: vi.fn().mockRejectedValue(new Error(`leaked ${secret}`)),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "network-error" });
    expect((thrown as Error).message).not.toContain(secret);
  });
});

describe("claimMarketingScheduleSlot", () => {
  it("claims the database-derived weekday slot through the hardened RPC transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseRow({
        result_code: "claimed",
        schedule_key: "weekday_product_update",
        slot_day: "2026-07-29",
        claimed_at: "2026-07-29T14:00:00.000Z",
      }),
    );

    await expect(
      claimMarketingScheduleSlot({ env: ENV, fetchImpl: fetchMock }),
    ).resolves.toEqual({
      result: "claimed",
      scheduleKey: "weekday_product_update",
      day: "2026-07-29",
      claimedAt: "2026-07-29T14:00:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/claim_marketing_schedule_slot",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: "{}",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns an existing weekday claim and a weekend non-slot without widening either result", async () => {
    await expect(
      claimMarketingScheduleSlot({
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({
            result_code: "already_claimed",
            schedule_key: "weekday_product_update",
            slot_day: "2026-07-29",
            claimed_at: "2026-07-29T14:00:00.000Z",
          }),
        ),
      }),
    ).resolves.toMatchObject({
      result: "already_claimed",
      day: "2026-07-29",
    });

    await expect(
      claimMarketingScheduleSlot({
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({
            result_code: "outside_schedule",
            schedule_key: "weekday_product_update",
            slot_day: "2026-08-01",
            claimed_at: null,
          }),
        ),
      }),
    ).resolves.toEqual({
      result: "outside_schedule",
      scheduleKey: "weekday_product_update",
      day: "2026-08-01",
      claimedAt: null,
    });
  });

  it("rejects inconsistent and oversized schedule-slot responses", async () => {
    for (const row of [
      {
        result_code: "claimed",
        schedule_key: "weekday_product_update",
        slot_day: "2026-07-29",
        claimed_at: null,
      },
      {
        result_code: "outside_schedule",
        schedule_key: "weekday_product_update",
        slot_day: "2026-07-29",
        claimed_at: null,
      },
      {
        result_code: "already_claimed",
        schedule_key: "another_schedule",
        slot_day: "2026-07-29",
        claimed_at: "2026-07-29T14:00:00.000Z",
      },
    ]) {
      await expect(
        claimMarketingScheduleSlot({
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(responseRow(row)),
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '[{"result_code":"claimed","schedule_key":"weekday_product_update","slot_day":"2026-07-29","claimed_at":"',
          ),
        );
        controller.enqueue(new Uint8Array(70_000).fill(97));
        controller.enqueue(new TextEncoder().encode('"}]'));
        controller.close();
      },
    });
    await expect(
      claimMarketingScheduleSlot({
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(new Response(oversizedBody)),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("claimNextReviewedMarketingCampaign", () => {
  it("claims the oldest source-reviewed campaign through the service-role RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(campaignQueueResponse());

    await expect(
      claimNextReviewedMarketingCampaign(["discord"], {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).resolves.toMatchObject({
      result: "claimed",
      scheduleKey: "weekday_product_update",
      day: "2026-07-29",
      campaign: {
        id: "virtual-trading-request-zap-v2",
        channel: "discord",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/claim_next_marketing_campaign",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ p_channels: ["discord"] }),
    });
  });

  it("returns no_pending_campaign without inventing campaign content", async () => {
    const emptyCampaign = {
      campaign_id: null,
      channel: null,
      queue_order: null,
      not_before: null,
      body: null,
      links: null,
      topics: null,
      disclosures: null,
      claims: null,
      flags: null,
      required_facts: null,
      canonical_source_urls: null,
      content_hash: null,
    };

    await expect(
      claimNextReviewedMarketingCampaign(["discord"], {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          campaignQueueResponse({
            result_code: "no_pending_campaign",
            claimed_at: null,
            ...emptyCampaign,
          }),
        ),
      }),
    ).resolves.toEqual({
      result: "no_pending_campaign",
      scheduleKey: "weekday_product_update",
      day: "2026-07-29",
      claimedAt: null,
      campaign: null,
    });
  });

  it("rejects unreviewed rows, copy drift, and invalid channel requests", async () => {
    await expect(
      claimNextReviewedMarketingCampaign(["discord"], {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          campaignQueueResponse({ body: "Changed after review." }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const fetchMock = vi.fn();
    await expect(
      claimNextReviewedMarketingCampaign([], {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyReviewedMarketingCampaignClaim", () => {
  const input = {
    campaignId: "virtual-trading-request-zap-v2",
    channel: "discord" as const,
    slotDay: "2026-07-29",
    contentHash:
      "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
  };

  it("verifies the exact durable day, channel, and reviewed content hash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseRow({
        verified: true,
        claimed_at: "2026-07-29T14:00:00.000Z",
      }),
    );

    await expect(
      verifyReviewedMarketingCampaignClaim(input, {
        env: ENV,
        fetchImpl: fetchMock,
      }),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/verify_marketing_campaign_schedule_claim",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      p_campaign_id: input.campaignId,
      p_channel: input.channel,
      p_slot_day: input.slotDay,
      p_content_hash: input.contentHash,
    });
  });

  it("fails closed for an absent claim, hash drift, or inconsistent response", async () => {
    await expect(
      verifyReviewedMarketingCampaignClaim(input, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({ verified: false, claimed_at: null }),
        ),
      }),
    ).resolves.toBe(false);

    const fetchMock = vi.fn();
    await expect(
      verifyReviewedMarketingCampaignClaim(
        { ...input, contentHash: "ab".repeat(32) },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      verifyReviewedMarketingCampaignClaim(input, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({ verified: true, claimed_at: null }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("claimMarketingDelivery", () => {
  const input = {
    idempotencyKey: "draft:abc:x",
    runId: "run-1",
    candidateId: "candidate-1",
    contentHash: "ab".repeat(32),
    channel: "x" as const,
    action: "broadcast" as const,
    interactionId: null,
    approvedBy: "Nodar",
    dailyCap: 2,
  };

  it("submits the exact atomic claim and parses an acquired slot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(claimResponse());

    await expect(
      claimMarketingDelivery(input, { env: ENV, fetchImpl: fetchMock }),
    ).resolves.toEqual({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: "2026-07-29",
      providerMessageId: null,
      providerUrl: null,
      failureCode: null,
      claimedAt: "2026-07-29T12:00:00.000Z",
      completedAt: null,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      p_idempotency_key: "draft:abc:x",
      p_run_id: "run-1",
      p_candidate_id: "candidate-1",
      p_content_hash: "ab".repeat(32),
      p_channel: "x",
      p_action: "broadcast",
      p_interaction_id: null,
      p_approved_by: "Nodar",
      p_daily_cap: 2,
    });
  });

  it.each([
    "already_claimed",
    "daily_cap_reached",
    "interaction_already_claimed",
    "idempotency_conflict",
  ] as const)("returns the fail-closed %s outcome without disguising it as a claim", async (result) => {
    const fetchMock = vi.fn().mockResolvedValue(
      claimResponse({
        result_code: result,
        resulting_status:
          result === "already_claimed" || result === "idempotency_conflict"
            ? "claimed"
            : null,
        current_count:
          result === "already_claimed"
            ? 1
            : result === "daily_cap_reached"
              ? 2
              : null,
        ...(result === "already_claimed"
          ? {}
          : {
              provider_message_id: null,
              provider_url: null,
              failure_code: null,
              claimed_at: null,
              completed_at: null,
            }),
      }),
    );
    await expect(
      claimMarketingDelivery(input, { env: ENV, fetchImpl: fetchMock }),
    ).resolves.toMatchObject({ result });
  });

  it("returns the original terminal receipt for exact replay reconciliation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      claimResponse({
        result_code: "already_claimed",
        resulting_status: "published",
        provider_message_id: "123",
        provider_url: "https://x.com/i/web/status/123",
        completed_at: "2026-07-29T12:01:00.000Z",
      }),
    );

    await expect(
      claimMarketingDelivery(input, { env: ENV, fetchImpl: fetchMock }),
    ).resolves.toMatchObject({
      result: "already_claimed",
      status: "published",
      providerMessageId: "123",
      providerUrl: "https://x.com/i/web/status/123",
      claimedAt: "2026-07-29T12:00:00.000Z",
      completedAt: "2026-07-29T12:01:00.000Z",
    });
  });

  it("rejects semantically inconsistent claim outcomes", async () => {
    for (const row of [
      {
        result_code: "claimed",
        resulting_status: "published",
        current_count: 1,
      },
      {
        result_code: "daily_cap_reached",
        resulting_status: null,
        current_count: null,
        claimed_at: null,
      },
      {
        result_code: "already_claimed",
        resulting_status: "claimed",
        current_count: 1,
        claimed_at: null,
      },
      {
        result_code: "already_claimed",
        resulting_status: "published",
        current_count: 1,
        provider_message_id: "123",
        provider_url: "https://x.com/i/web/status/123?token=secret",
        completed_at: "2026-07-29T12:01:00.000Z",
      },
    ]) {
      await expect(
        claimMarketingDelivery(input, {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(claimResponse(row)),
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("validates action, interaction, cap, identity, and content hash before RPC", async () => {
    const fetchMock = vi.fn();
    for (const invalid of [
      { ...input, idempotencyKey: "contains spaces" },
      { ...input, contentHash: "not-a-hash" },
      { ...input, dailyCap: 101 },
      { ...input, action: "reply" as const, interactionId: null },
      { ...input, channel: "substack" as const, action: "broadcast" as const },
      { ...input, action: "direct_message" as const },
      { ...input, channel: "discord" as const, action: "reply" as const },
      {
        ...input,
        channel: "substack" as const,
        action: "publish_tutorial" as const,
      },
    ]) {
      await expect(
        claimMarketingDelivery(invalid, { env: ENV, fetchImpl: fetchMock }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("completeMarketingDeliveryClaim", () => {
  it("persists a safe provider receipt after delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseRow({
        result_code: "finalized",
        resulting_status: "published",
      }),
    );
    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "published",
          providerMessageId: "123",
          providerUrl: "https://x.com/i/web/status/123",
        },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).resolves.toEqual({ result: "finalized", status: "published" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      p_idempotency_key: "draft:abc:x",
      p_channel: "x",
      p_action: "broadcast",
      p_status: "published",
      p_provider_message_id: "123",
      p_provider_url: "https://x.com/i/web/status/123",
      p_failure_code: null,
    });
  });

  it("requires a bounded safe code for failures and rejects unknown RPC outcomes", async () => {
    const fetchMock = vi.fn();
    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "failed",
          failureCode: "contains spaces",
        },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "failed",
          failureCode: "provider-error",
        },
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            responseRow({ result_code: "surprise", resulting_status: "failed" }),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("binds terminal receipts to deployed channel/action pairs and canonical provider metadata", async () => {
    const fetchMock = vi.fn();
    for (const invalid of [
      {
        idempotencyKey: "draft:abc:x",
        channel: "x" as const,
        action: "broadcast" as const,
        status: "published" as const,
        providerMessageId: "not-an-x-id",
        providerUrl: "https://x.com/i/web/status/not-an-x-id",
      },
      {
        idempotencyKey: "draft:abc:x",
        channel: "x" as const,
        action: "broadcast" as const,
        status: "published" as const,
        providerMessageId: "123",
        providerUrl: "https://x.com/i/web/status/123?token=secret",
      },
      {
        idempotencyKey: "draft:abc:discord",
        channel: "discord" as const,
        action: "reply" as const,
        status: "published" as const,
        providerMessageId: "123",
      },
      {
        idempotencyKey: "draft:abc:substack",
        channel: "substack" as const,
        action: "prepare_tutorial" as const,
        status: "published" as const,
        providerMessageId: "123",
      },
      {
        idempotencyKey: "draft:abc:substack",
        channel: "substack" as const,
        action: "prepare_tutorial" as const,
        status: "requires_human_publish" as const,
        providerUrl:
          "https://defitutorials.substack.com/publish/post?api_key=secret",
      },
    ]) {
      await expect(
        completeMarketingDeliveryClaim(invalid, {
          env: ENV,
          fetchImpl: fetchMock,
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only semantically matching terminal and replay results", async () => {
    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "published",
          providerMessageId: "123",
          providerUrl: "https://x.com/i/web/status/123",
        },
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            responseRow({
              result_code: "already_finalized",
              resulting_status: "published",
            }),
          ),
        },
      ),
    ).resolves.toEqual({ result: "already_finalized", status: "published" });

    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "published",
          providerMessageId: "123",
          providerUrl: "https://x.com/i/web/status/123",
        },
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            responseRow({
              result_code: "status_conflict",
              resulting_status: null,
            }),
          ),
        },
      ),
    ).resolves.toEqual({ result: "status_conflict", status: null });

    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "x",
          action: "broadcast",
          status: "published",
          providerMessageId: "123",
          providerUrl: "https://x.com/i/web/status/123",
        },
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            responseRow({
              result_code: "already_finalized",
              resulting_status: "failed",
            }),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });

    await expect(
      completeMarketingDeliveryClaim(
        {
          idempotencyKey: "draft:abc:x",
          channel: "substack",
          action: "prepare_tutorial",
          status: "requires_human_publish",
          providerUrl: "https://defitutorials.substack.com/publish/post",
        },
        {
          env: ENV,
          fetchImpl: vi.fn().mockResolvedValue(
            responseRow({
              result_code: "not_found",
              resulting_status: "published",
            }),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
