import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketingLedgerError } from "@/lib/marketing/ledger-server";
import { MAX_VOLATILE_MARKETING_SOURCE_AGE_MS } from "@/lib/marketing/policy";
import type { MarketingDraftBundle } from "@/workflows/marketing-agent/contracts";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  discord: vi.fn(),
  discordWebhook: vi.fn(),
  generateText: vi.fn(),
  getSnapshot: vi.fn(),
  verifyDiscordDestination: vi.fn(),
  verifyXIdentity: vi.fn(),
  verifyXReplyTarget: vi.fn(),
  xBroadcast: vi.fn(),
  xReply: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn() },
}));
vi.mock("workflow", () => ({
  getWritable: vi.fn(),
}));
vi.mock("@/lib/marketing/ledger-server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/marketing/ledger-server")>();
  return {
    ...actual,
    claimMarketingDelivery: mocks.claim,
    completeMarketingDeliveryClaim: mocks.complete,
    getMarketingLedgerSnapshot: mocks.getSnapshot,
  };
});
vi.mock("@/lib/marketing/channels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/marketing/channels")>();
  return {
    ...actual,
    postDiscordMessage: mocks.discord,
    postDiscordWebhook: mocks.discordWebhook,
    postXBroadcast: mocks.xBroadcast,
    postXReply: mocks.xReply,
    verifyDiscordPublishDestination: mocks.verifyDiscordDestination,
    verifyXAuthenticatedIdentity: mocks.verifyXIdentity,
    verifyXReplyTarget: mocks.verifyXReplyTarget,
  };
});

import {
  buildScheduledMarketingDraftStep,
  collectMarketingSourcesStep,
  generateMarketingDraftStep,
  notifyMarketingReviewStep,
  publishMarketingBundleStep,
  publishScheduledMarketingBundleStep,
} from "@/workflows/marketing-agent/steps";

const CREATED_AT = new Date().toISOString();
const VIRTUAL_TRADING_PAGE_HTML =
  "Virtual Trading starts with 10,000 virtual USDG. Nothing here can move money. No wallet required. No deposit or approval. No signature or transaction.";
const REQUEST_ZAP_PAGE_HTML =
  "Request a Zap is human-reviewed. Get its authority map.";

function bundle(): MarketingDraftBundle {
  const sourcePacket = {
    id: "sources:test",
    createdAt: CREATED_AT,
    protocolPreAudit: true,
    facts: [
      {
        key: "release_status",
        label: "Release status",
        value: "live",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/api/health",
        observedAt: CREATED_AT,
      },
    ],
    externalData: [],
    interaction: null,
  };
  const candidate = {
    id: "draft:abc:x",
    channel: "x" as const,
    action: "broadcast" as const,
    kind: "product_update" as const,
    topics: ["protocol" as const],
    body:
      "A source-backed OpenZaps update. Pre-audit software. Verify before use. https://www.0xzaps.com/zap",
    links: ["https://www.0xzaps.com/zap"],
    disclosures: ["pre_audit" as const],
    claims: [
      {
        text: "The update is live.",
        factKeys: ["release_status"],
        treatment: "asserted" as const,
      },
    ],
    sourcePacket,
    interaction: null,
    flags: {
      containsCredential: false,
      guaranteesReturns: false,
      impersonatesPerson: false,
      requestsPolicyBypass: false,
      unsolicitedBulkMessaging: false,
      usesUnavailableAsZero: false,
    },
  };
  return {
    id: "draft:abc",
    runId: "run-1",
    requestedAt: CREATED_AT,
    model: "test-model",
    request: {
      kind: "product_update",
      brief: "Share the verified OpenZaps update.",
      channels: ["x"],
      sourceUrls: [],
    },
    sourcePacket,
    candidates: [candidate],
    presentations: [{ candidateId: candidate.id, channel: "x" }],
    policy: [
      {
        policyVersion: 2,
        candidateId: candidate.id,
        riskTier: 1,
        disposition: "require_approval",
        approvalRequired: true,
        approvalReasons: ["every_run_human_approval"],
        requiredDisclosures: ["pre_audit"],
        dailyCounter: "xPosts",
        issues: [],
        evaluatedAt: CREATED_AT,
      },
    ],
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
  };
}

function setLiveEnvironment(): void {
  vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "false");
  vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "false");
  vi.stubEnv("OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED", "true");
  vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "false");
  vi.stubEnv("OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED", "true");
  vi.stubEnv("X_USER_ACCESS_TOKEN", "x-user-token");
  vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
  vi.stubEnv("X_EXPECTED_USERNAME", "0xzaps");
  vi.stubEnv("OPENZAPS_MARKETING_SUPABASE_PROJECT_REF", "abcdefghijklmnopqrst");
  vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-secret");
}

function zeroSnapshot() {
  return {
    source: "durable" as const,
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
  };
}

function virtualMarketSnapshot() {
  return {
    chainId: 4663,
    blockNumber: "23258886",
    blockHash: `0x${"cd".repeat(32)}`,
    blockTimestamp: String(Math.floor(Date.parse(CREATED_AT) / 1_000)),
    readAt: CREATED_AT,
    source: "canonical Robinhood Chain head eth_call",
    markets: [
      {
        marketId: "zaps",
        symbol: "0xZAPS",
        routeId: "robinhood-v4-route-zaps-usdg",
        sampleInputRaw: "1000000000000000000000000",
        sampleOutputRaw: "733800",
        priceWad: "733800000000",
      },
      {
        marketId: "weth",
        symbol: "aeWETH",
        routeId: "robinhood-v4-weth-usdg",
        sampleInputRaw: "10000000000000000",
        sampleOutputRaw: "19180000",
        priceWad: "1918000000000000000000",
      },
    ],
  };
}

function virtualQuote() {
  return {
    clientOrderId: "marketing-readiness",
    portfolioRevision: 0,
    marketId: "weth",
    side: "buy",
    routeId: "robinhood-v4-usdg-weth",
    inputRaw: "1000000",
    outputRaw: "500000000000000",
    gasEstimate: "12345",
    chainId: 4663,
    blockNumber: "23258886",
    blockHash: `0x${"ef".repeat(32)}`,
    blockTimestamp: String(Math.floor(Date.parse(CREATED_AT) / 1_000)),
    quotedAt: CREATED_AT,
    expiresAt: new Date(Date.parse(CREATED_AT) + 45_000).toISOString(),
  };
}

function scheduledSourcePacket() {
  const sourcePacket = bundle().sourcePacket;
  return {
    ...sourcePacket,
    facts: [
      {
        key: "product.virtual_trading",
        label: "Virtual Trading",
        value:
          "Browser-local paper trading starts with 10,000 virtual USDG without a wallet, approval, signature, transaction, or real funds.",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/virtual-trading",
        observedAt: CREATED_AT,
      },
      {
        key: "product.virtual_trading_markets",
        label: "Virtual Trading market marks",
        value:
          "Current read-only canonical-head marks are available for the deployed 0xZAPS/USDG and aeWETH/USDG routes.",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/api/virtual-trading/markets",
        observedAt: CREATED_AT,
      },
      {
        key: "product.virtual_trading_quote",
        label: "Virtual Trading quote readiness",
        value:
          "The read-only paper-trade quote endpoint returned a fresh canonical-head quote without a wallet or transaction.",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/api/virtual-trading/quote",
        observedAt: CREATED_AT,
      },
      {
        key: "product.request_a_zap",
        label: "Request a Zap page",
        value:
          "The Request a Zap page describes a human-reviewed authority map for one workflow; the review is not an automatic deployment promise.",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/request-a-zap",
        observedAt: CREATED_AT,
      },
      {
        key: "product.request_a_zap_intake",
        label: "Request a Zap intake readiness",
        value:
          "The non-mutating readiness probe confirmed authenticated access to the deployed lead-intake RPC.",
        status: "confirmed" as const,
        sourceUrl: "https://www.0xzaps.com/api/leads/request",
        observedAt: CREATED_AT,
      },
      {
        key: "authority.execution",
        label: "Execution authority",
        value:
          "The immutable Zap policy and owner-signed intent define what may execute.",
        status: "confirmed" as const,
        sourceUrl:
          "https://github.com/0pen-Zaps/openzaps/blob/main/docs/adr/0006-agent-connection-and-mcp-surface.md",
        observedAt: CREATED_AT,
      },
      {
        key: "authority.submission",
        label: "Submission authority",
        value:
          "An agent may submit a due run but cannot widen its signed terms.",
        status: "confirmed" as const,
        sourceUrl:
          "https://github.com/0pen-Zaps/openzaps/blob/main/docs/adr/0006-agent-connection-and-mcp-surface.md",
        observedAt: CREATED_AT,
      },
    ],
  };
}

function replyBundle(): MarketingDraftBundle {
  const base = bundle();
  const interaction = {
    id: "123456789",
    targetUrl: "https://x.com/community/status/123456789",
    authorId: "200",
    authenticatedAccountId: "100",
    trigger: "mention" as const,
    observedAt: CREATED_AT,
  };
  const sourcePacket = { ...base.sourcePacket, interaction };
  const candidate = {
    ...base.candidates[0],
    action: "reply" as const,
    kind: "community_reply" as const,
    interaction,
    sourcePacket,
  };
  return {
    ...base,
    request: {
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      sourceUrls: [],
      interactionUrl: interaction.targetUrl,
    },
    sourcePacket,
    candidates: [candidate],
    policy: [{
      ...base.policy[0],
      dailyCounter: "xReplies",
    }],
  };
}

function discordBundle(): MarketingDraftBundle {
  const base = bundle();
  const candidate = {
    ...base.candidates[0],
    id: "draft:abc:discord",
    channel: "discord" as const,
  };
  return {
    ...base,
    request: {
      ...base.request,
      channels: ["discord"],
    },
    candidates: [candidate],
    presentations: [
      { candidateId: candidate.id, channel: "discord" as const },
    ],
    policy: [{
      ...base.policy[0],
      candidateId: candidate.id,
      dailyCounter: "discordPosts",
    }],
  };
}

beforeEach(() => {
  mocks.verifyDiscordDestination.mockResolvedValue(undefined);
  mocks.verifyXIdentity.mockResolvedValue({
    authenticatedAccountId: "100",
    authenticatedUsername: "0xzaps",
    observedAt: CREATED_AT,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable marketing delivery admission", () => {
  it("claims before the provider call and durably finalizes its receipt", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
    });
    mocks.xBroadcast.mockResolvedValue({
      providerMessageId: "123",
      providerUrl: "https://x.com/i/web/status/123",
    });
    mocks.complete.mockResolvedValue({
      result: "finalized",
      status: "published",
    });

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([{ status: "published", providerMessageId: "123" }]);

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "draft:abc:x",
        runId: "run-1",
        candidateId: "draft:abc:x",
        channel: "x",
        action: "broadcast",
        interactionId: null,
        approvedBy: "Nodar",
        dailyCap: 2,
      }),
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.xBroadcast.mock.invocationCallOrder[0],
    );
    expect(mocks.verifyXIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0],
    );
    expect(mocks.complete).toHaveBeenCalledWith({
      idempotencyKey: "draft:abc:x",
      channel: "x",
      action: "broadcast",
      status: "published",
      providerMessageId: "123",
      providerUrl: "https://x.com/i/web/status/123",
    });
  });

  it.each([
    [
      "network failure",
      () =>
        new MarketingLedgerError(
          "network-error",
          "The durable marketing delivery ledger could not be reached.",
        ),
    ],
    [
      "5xx response",
      () =>
        new MarketingLedgerError(
          "rpc-error",
          "The durable marketing delivery ledger rejected the request (503).",
          503,
        ),
    ],
  ])(
    "retries idempotent receipt finalization once after a transient %s",
    async (_label, firstError) => {
      setLiveEnvironment();
      mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
      mocks.claim.mockResolvedValue({
        result: "claimed",
        status: "claimed",
        currentCount: 1,
        day: zeroSnapshot().usage.day,
      });
      mocks.xBroadcast.mockResolvedValue({
        providerMessageId: "123",
        providerUrl: "https://x.com/i/web/status/123",
      });
      mocks.complete
        .mockRejectedValueOnce(firstError())
        .mockResolvedValueOnce({
          result: "already_finalized",
          status: "published",
        });

      await expect(
        publishMarketingBundleStep(bundle(), {
          decision: "approve",
          approvedBy: "Nodar",
        }),
      ).resolves.toMatchObject([
        { status: "published", providerMessageId: "123" },
      ]);

      expect(mocks.xBroadcast).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [
      "invalid input",
      () =>
        Promise.reject(
          new MarketingLedgerError(
            "invalid-input",
            "Marketing delivery completion input is invalid.",
          ),
        ),
    ],
    [
      "4xx response",
      () =>
        Promise.reject(
          new MarketingLedgerError(
            "rpc-error",
            "The durable marketing delivery ledger rejected the request (409).",
            409,
          ),
        ),
    ],
    [
      "state conflict",
      () =>
        Promise.resolve({
          result: "status_conflict",
          status: "published",
        }),
    ],
  ])(
    "does not retry receipt finalization after %s",
    async (_label, completionOutcome) => {
      setLiveEnvironment();
      mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
      mocks.claim.mockResolvedValue({
        result: "claimed",
        status: "claimed",
        currentCount: 1,
        day: zeroSnapshot().usage.day,
      });
      mocks.xBroadcast.mockResolvedValue({
        providerMessageId: "123",
        providerUrl: "https://x.com/i/web/status/123",
      });
      mocks.complete.mockImplementation(completionOutcome);

      await expect(
        publishMarketingBundleStep(bundle(), {
          decision: "approve",
          approvedBy: "Nodar",
        }),
      ).resolves.toMatchObject([
        {
          status: "failed",
          error: expect.stringContaining("could not be finalized"),
        },
      ]);

      expect(mocks.xBroadcast).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledOnce();
    },
  );

  it("reconciles the original receipt without re-entering the provider", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "already_claimed",
      status: "published",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
      providerMessageId: "456",
      providerUrl: "https://x.com/i/web/status/456",
      failureCode: null,
      claimedAt: "2026-07-29T12:00:00.000Z",
      completedAt: "2026-07-29T12:01:00.000Z",
    });

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "published",
        providerMessageId: "456",
        providerUrl: "https://x.com/i/web/status/456",
      },
    ]);
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps a prior in-flight claim ambiguous and never resends it", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "already_claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
      providerMessageId: null,
      providerUrl: null,
      failureCode: null,
      claimedAt: "2026-07-29T12:00:00.000Z",
      completedAt: null,
    });

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "failed",
        error: expect.stringContaining("requires human reconciliation"),
      },
    ]);
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("retains an ambiguous provider exception as claimed for reconciliation", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
    });
    mocks.xBroadcast.mockRejectedValue(new Error("timeout with secret body"));

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "failed",
        error: expect.stringContaining("remains claimed"),
      },
    ]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("fails closed before claiming or publishing when the live snapshot is unavailable", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockRejectedValue(new Error("ledger unavailable"));

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).rejects.toThrow("ledger unavailable");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("uses the explicit empty snapshot only for a side-effect-free dry run", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
    vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "true");

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([{ status: "dry_run" }]);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("fails X identity preflight before a durable claim or provider call", async () => {
    setLiveEnvironment();
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyXIdentity.mockRejectedValue(new Error("wrong X account"));

    await expect(
      publishMarketingBundleStep(bundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "blocked",
        error: expect.stringContaining("identity verification failed"),
      },
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("fails Discord destination preflight before a durable claim or provider call", async () => {
    setLiveEnvironment();
    vi.stubEnv(
      "DISCORD_MARKETING_WEBHOOK_URL",
      "https://discord.com/api/webhooks/123/public-token",
    );
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
    vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyDiscordDestination.mockRejectedValue(
      new Error("wrong Discord destination"),
    );

    await expect(
      publishMarketingBundleStep(discordBundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "blocked",
        error: expect.stringContaining("destination verification failed"),
      },
    ]);
    expect(mocks.verifyDiscordDestination).toHaveBeenCalledOnce();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it("blocks a reply when reverified identity differs from immutable evidence", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyXIdentity.mockResolvedValue({
      authenticatedAccountId: "999",
      authenticatedUsername: "0xzaps",
      observedAt: CREATED_AT,
    });

    await expect(
      publishMarketingBundleStep(replyBundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([
      {
        status: "blocked",
        error: expect.stringContaining("immutable reply verification"),
      },
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xReply).not.toHaveBeenCalled();
  });

  it("passes immutable authenticated account id into an admitted X reply", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
    });
    mocks.xReply.mockResolvedValue({
      providerMessageId: "321",
      providerUrl: "https://x.com/i/web/status/321",
    });
    mocks.complete.mockResolvedValue({
      result: "finalized",
      status: "published",
    });

    await expect(
      publishMarketingBundleStep(replyBundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([{ status: "published" }]);
    expect(mocks.verifyXIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0],
    );
    expect(mocks.xReply).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyToTweetId: "123456789",
        authenticatedAccountId: "100",
      }),
    );
  });

  it("blocks a duplicate verified X interaction before durable admission or provider delivery", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "true");
    mocks.getSnapshot.mockResolvedValue({
      ...zeroSnapshot(),
      repliedInteractionIds: ["123456789"],
    });

    await expect(
      publishMarketingBundleStep(replyBundle(), {
        decision: "approve",
        approvedBy: "Nodar",
      }),
    ).resolves.toMatchObject([{ status: "blocked" }]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xReply).not.toHaveBeenCalled();
  });

  it("auto-publishes only the exact versioned scheduled template", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
    });
    mocks.xBroadcast.mockResolvedValue({
      providerMessageId: "777",
      providerUrl: "https://x.com/i/web/status/777",
    });
    mocks.complete.mockResolvedValue({
      result: "finalized",
      status: "published",
    });

    const draft = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-1",
    );
    expect(draft.model).toBe(
      "deterministic/virtual-trading-request-zap-v2",
    );
    expect(draft.policy).toEqual([
      expect.objectContaining({
        disposition: "allow",
        riskTier: 1,
        approvalRequired: false,
        approvalReasons: [],
      }),
    ]);
    expect(mocks.generateText).not.toHaveBeenCalled();

    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([
      { status: "published", providerMessageId: "777" },
    ]);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "scheduled:virtual-trading-request-zap-v2:x",
        approvedBy: "system:virtual-trading-request-zap-v2",
        channel: "x",
        action: "broadcast",
      }),
    );
    expect(mocks.xBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ madeWithAi: false }),
    );
  });

  it("rechecks volatile evidence after provider preflight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyXIdentity.mockImplementation(async () => {
      vi.setSystemTime(
        new Date(
          Date.parse(CREATED_AT)
            + MAX_VOLATILE_MARKETING_SOURCE_AGE_MS
            + 1,
        ),
      );
      return {
        authenticatedAccountId: "100",
        authenticatedUsername: "0xzaps",
        observedAt: CREATED_AT,
      };
    });

    const draft = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-delayed",
    );
    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([
      {
        status: "blocked",
        error: expect.stringContaining("final provider admission"),
      },
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("uses the same bounded path for a verified Discord destination", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    vi.stubEnv(
      "DISCORD_MARKETING_WEBHOOK_URL",
      "https://discord.com/api/webhooks/123/public-token",
    );
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
    vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "claimed",
      status: "claimed",
      currentCount: 1,
      day: zeroSnapshot().usage.day,
    });
    mocks.discord.mockResolvedValue({ providerMessageId: "888" });
    mocks.complete.mockResolvedValue({
      result: "finalized",
      status: "published",
    });

    const draft = await buildScheduledMarketingDraftStep(
      { channels: ["discord"] },
      scheduledSourcePacket(),
      "scheduled-run-discord",
    );
    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([
      { channel: "discord", status: "published", providerMessageId: "888" },
    ]);

    expect(mocks.verifyDiscordDestination).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          "scheduled:virtual-trading-request-zap-v2:discord",
        channel: "discord",
      }),
    );
    expect(mocks.discord).toHaveBeenCalledOnce();
  });

  it("fails closed when a later run reuses a claimed template key", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim.mockResolvedValue({
      result: "idempotency_conflict",
      status: "published",
      providerMessageId: null,
      providerUrl: null,
      currentCount: null,
      day: zeroSnapshot().usage.day,
    });

    const first = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-1",
    );
    const second = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-2",
    );
    expect(second.id).toBe(first.id);

    await expect(
      publishScheduledMarketingBundleStep(second),
    ).resolves.toMatchObject([
      {
        channel: "x",
        status: "blocked",
        error: expect.stringContaining("idempotency_conflict"),
      },
    ]);

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "scheduled:virtual-trading-request-zap-v2:x",
      }),
    );
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("blocks scheduled body, claim, and evidence tampering before a provider write", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    const draft = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-1",
    );
    const baseCandidate = draft.candidates[0]!;
    const variants: MarketingDraftBundle[] = [
      {
        ...draft,
        candidates: [
          { ...baseCandidate, body: `${baseCandidate.body} Changed.` },
        ],
      },
      {
        ...draft,
        candidates: [
          { ...baseCandidate, claims: baseCandidate.claims.slice(0, 1) },
        ],
      },
      {
        ...draft,
        sourcePacket: { ...draft.sourcePacket, facts: [] },
        candidates: [
          {
            ...baseCandidate,
            sourcePacket: { ...baseCandidate.sourcePacket, facts: [] },
          },
        ],
      },
    ];

    for (const variant of variants) {
      await expect(
        publishScheduledMarketingBundleStep(variant),
      ).resolves.toMatchObject([{ status: "blocked" }]);
    }
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("rechecks the automatic authority immediately before durable admission", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    const draft = await buildScheduledMarketingDraftStep(
      { channels: ["x"] },
      scheduledSourcePacket(),
      "scheduled-run-1",
    );

    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "false");
    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([{ status: "blocked" }]);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });
});

describe("bounded source collection", () => {
  it("persists only API-verified reply metadata and source facts", async () => {
    const interaction = {
      id: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger: "mention" as const,
      observedAt: CREATED_AT,
    };
    mocks.verifyXReplyTarget.mockResolvedValue(interaction);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));

    const result = await collectMarketingSourcesStep({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      sourceUrls: [],
      interactionUrl: interaction.targetUrl,
    });

    expect(mocks.verifyXReplyTarget).toHaveBeenCalledWith(interaction.targetUrl);
    expect(result.interaction).toEqual(interaction);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "x.interaction.trigger",
          value: "mention",
          sourceUrl: interaction.targetUrl,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("target post text");
  });

  it("confirms feature facts only from live page markers and canonical market marks", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.endsWith("/api/virtual-trading/markets")) {
        return Promise.resolve(Response.json(virtualMarketSnapshot()));
      }
      if (input.endsWith("/api/virtual-trading/quote")) {
        return Promise.resolve(Response.json(virtualQuote()));
      }
      if (input.endsWith("/api/leads/request")) {
        return Promise.resolve(Response.json({ ready: true }));
      }
      if (input.endsWith("/virtual-trading")) {
        return Promise.resolve(
          new Response(VIRTUAL_TRADING_PAGE_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }
      if (input.endsWith("/request-a-zap")) {
        return Promise.resolve(
          new Response(REQUEST_ZAP_PAGE_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "product.virtual_trading",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/virtual-trading",
        }),
        expect.objectContaining({
          key: "product.virtual_trading_markets",
          status: "confirmed",
          sourceUrl:
            "https://www.0xzaps.com/api/virtual-trading/markets",
        }),
        expect.objectContaining({
          key: "product.virtual_trading_quote",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/api/virtual-trading/quote",
        }),
        expect.objectContaining({
          key: "product.request_a_zap",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/request-a-zap",
        }),
        expect.objectContaining({
          key: "product.request_a_zap_intake",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/api/leads/request",
        }),
      ]),
    );
  });

  it.each([
    ["stale", -6 * 60 * 1_000],
    ["future-skewed", 2 * 60 * 1_000],
  ])("rejects %s market and quote evidence", async (_label, offsetMs) => {
    const evidenceAt = new Date(Date.parse(CREATED_AT) + offsetMs);
    const blockTimestamp = String(Math.floor(evidenceAt.getTime() / 1_000));
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.endsWith("/api/virtual-trading/markets")) {
        return Promise.resolve(
          Response.json({
            ...virtualMarketSnapshot(),
            readAt: evidenceAt.toISOString(),
            blockTimestamp,
          }),
        );
      }
      if (input.endsWith("/api/virtual-trading/quote")) {
        return Promise.resolve(
          Response.json({
            ...virtualQuote(),
            quotedAt: evidenceAt.toISOString(),
            expiresAt: new Date(evidenceAt.getTime() + 45_000).toISOString(),
            blockTimestamp,
          }),
        );
      }
      if (input.endsWith("/api/leads/request")) {
        return Promise.resolve(Response.json({ ready: true }));
      }
      if (input.endsWith("/virtual-trading")) {
        return Promise.resolve(
          new Response(VIRTUAL_TRADING_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (input.endsWith("/request-a-zap")) {
        return Promise.resolve(
          new Response(REQUEST_ZAP_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: [],
    });
    const facts = new Map(result.facts.map((fact) => [fact.key, fact]));

    expect(facts.get("product.virtual_trading_markets")).toMatchObject({
      status: "unavailable",
      value: null,
    });
    expect(facts.get("product.virtual_trading_quote")).toMatchObject({
      status: "unavailable",
      value: null,
    });
  });

  it.each([
    ["reversed", 0, -1],
    ["expired", -60_000, 45_000],
    ["overlong", 0, 60_000],
  ])(
    "rejects a %s quote expiry",
    async (_label, quotedOffsetMs, expiryOffsetMs) => {
      const quotedAt = new Date(Date.parse(CREATED_AT) + quotedOffsetMs);
      const expiresAt = new Date(quotedAt.getTime() + expiryOffsetMs);
      const fetchMock = vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/api/virtual-trading/markets")) {
          return Promise.resolve(Response.json(virtualMarketSnapshot()));
        }
        if (input.endsWith("/api/virtual-trading/quote")) {
          return Promise.resolve(
            Response.json({
              ...virtualQuote(),
              quotedAt: quotedAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              blockTimestamp: String(
                Math.floor(quotedAt.getTime() / 1_000),
              ),
            }),
          );
        }
        if (input.endsWith("/api/leads/request")) {
          return Promise.resolve(Response.json({ ready: true }));
        }
        if (input.endsWith("/virtual-trading")) {
          return Promise.resolve(
            new Response(VIRTUAL_TRADING_PAGE_HTML, {
              headers: { "content-type": "text/html" },
            }),
          );
        }
        if (input.endsWith("/request-a-zap")) {
          return Promise.resolve(
            new Response(REQUEST_ZAP_PAGE_HTML, {
              headers: { "content-type": "text/html" },
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await collectMarketingSourcesStep({
        kind: "product_update",
        brief: "Collect a verified product update.",
        channels: ["x"],
        sourceUrls: [],
      });
      const facts = new Map(result.facts.map((fact) => [fact.key, fact]));

      expect(facts.get("product.virtual_trading_markets")).toMatchObject({
        status: "confirmed",
      });
      expect(facts.get("product.virtual_trading_quote")).toMatchObject({
        status: "unavailable",
        value: null,
      });
    },
  );

  it("rejects redirects and cancels streamed JSON once its byte cap is crossed", async () => {
    const cancelled = vi.fn();
    const fetchMock = vi.fn().mockImplementation(() => {
      let chunk = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunk < 2) {
                chunk += 1;
                controller.enqueue(new Uint8Array(600_000).fill(97));
              }
            },
            cancel() {
              cancelled();
            },
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.redirect).toBe("error");
    }
    expect(cancelled).toHaveBeenCalledTimes(6);
    expect(
      result.facts
        .filter((fact) => fact.key.startsWith("protocol."))
        .every((fact) => fact.status === "unavailable"),
    ).toBe(true);
    expect(
      result.facts
        .filter((fact) => fact.key.startsWith("product."))
        .every((fact) => fact.status === "unavailable"),
    ).toBe(true);
  });

  it("enforces the smaller streamed byte cap on allowlisted external evidence", async () => {
    const cancelled = vi.fn();
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes("/api/")) return Promise.resolve(Response.json({}));
      if (input.endsWith("/virtual-trading")) {
        return Promise.resolve(
          new Response(VIRTUAL_TRADING_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (input.endsWith("/request-a-zap")) {
        return Promise.resolve(
          new Response(REQUEST_ZAP_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      let chunk = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunk < 2) {
                chunk += 1;
                controller.enqueue(new Uint8Array(16_000).fill(97));
              }
            },
            cancel() {
              cancelled();
            },
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: ["https://defitutorials.substack.com/p/openzaps"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.redirect).toBe("error");
    }
    expect(cancelled).toHaveBeenCalledOnce();
    expect(result.externalData).toEqual([]);
  });

  it("drops allowlisted external evidence that contains credential-like data", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes("/api/")) return Promise.resolve(Response.json({}));
      if (input.endsWith("/virtual-trading")) {
        return Promise.resolve(
          new Response(VIRTUAL_TRADING_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (input.endsWith("/request-a-zap")) {
        return Promise.resolve(
          new Response(REQUEST_ZAP_PAGE_HTML, {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          "Leaked webhook https://discord.com/api/webhooks/123456789/example-secret-token",
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: ["https://defitutorials.substack.com/p/openzaps"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(result.externalData).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("example-secret-token");
  });

  it("fails draft generation without SDK or Workflow retries", async () => {
    const input = bundle();
    mocks.generateText.mockRejectedValueOnce(new Error("model unavailable"));

    await expect(
      generateMarketingDraftStep(input.request, input.sourcePacket, input.runId),
    ).rejects.toThrow("model unavailable");

    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(generateMarketingDraftStep.maxRetries).toBe(0);
  });

  it("disables Workflow retries for review notifications and publishing", () => {
    expect(publishMarketingBundleStep.maxRetries).toBe(0);
    expect(publishScheduledMarketingBundleStep.maxRetries).toBe(0);
    expect(notifyMarketingReviewStep.maxRetries).toBe(0);
  });

  it("binds review notifications to the configured private Discord channel", async () => {
    vi.stubEnv(
      "DISCORD_MARKETING_REVIEW_WEBHOOK_URL",
      "https://discord.com/api/webhooks/456/review-token",
    );
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "789");
    vi.stubEnv("DISCORD_MARKETING_REVIEW_CHANNEL_ID", "101112");
    mocks.discordWebhook.mockResolvedValue({
      providerMessageId: "131415",
    });

    await expect(notifyMarketingReviewStep(bundle())).resolves.toEqual({
      sent: true,
      providerMessageId: "131415",
    });
    expect(mocks.discordWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "review:draft:abc",
      }),
      {
        webhookUrl: "https://discord.com/api/webhooks/456/review-token",
        guildId: "789",
        channelId: "101112",
      },
    );
  });
});
