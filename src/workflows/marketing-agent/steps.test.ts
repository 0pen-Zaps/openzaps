import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketingLedgerError } from "@/lib/marketing/ledger-server";
import { MAX_VOLATILE_MARKETING_SOURCE_AGE_MS } from "@/lib/marketing/policy";
import {
  NON_PUBLIC_TUTORIAL_TITLES,
  PUBLIC_CONTENT_CATALOG_DIGEST,
  PUBLIC_CONTENT_ITEMS,
} from "@/lib/marketing/public-content";
import type { MarketingDraftBundle } from "@/workflows/marketing-agent/contracts";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  discord: vi.fn(),
  discordWebhook: vi.fn(),
  generateText: vi.fn(),
  getSnapshot: vi.fn(),
  verifyDiscordDestination: vi.fn(),
  verifyCampaignClaim: vi.fn(),
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
    verifyReviewedMarketingCampaignClaim: mocks.verifyCampaignClaim,
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
  npmReleaseHasProvenance,
  notifyMarketingReviewStep,
  publishMarketingBundleStep,
  publishScheduledMarketingBundleStep,
} from "@/workflows/marketing-agent/steps";

const VALID_NPM_RELEASE = {
  name: "@openzaps/sdk",
  version: "0.1.0",
  repository: {
    type: "git",
    url: "git+https://github.com/0pen-Zaps/openzaps.git",
    directory: "packages/sdk",
  },
  publishConfig: { access: "public", provenance: true },
  dist: {
    integrity: `sha512-${Buffer.alloc(64, 97).toString("base64")}`,
    attestations: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/@openzaps%2fsdk@0.1.0",
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
      },
    },
  },
};

const LEARN_PAGE_HTML = [
  `<main data-publication-boundary="reviewed-feed-and-rss-confirmed" data-public-content-count="${PUBLIC_CONTENT_ITEMS.length}" data-public-content-digest="${PUBLIC_CONTENT_CATALOG_DIGEST}">`,
  ...PUBLIC_CONTENT_ITEMS.map(
    (item) =>
      `<article data-public-content-id="${item.id}"><h3>${item.title}</h3><a href="${item.canonicalUrl}">Read</a></article>`,
  ),
  "</main>",
].join("");

const SWAPPED_LEARN_CARD_HTML = LEARN_PAGE_HTML
  .replace(PUBLIC_CONTENT_ITEMS[0]!.title, "__FIRST_TITLE__")
  .replace(PUBLIC_CONTENT_ITEMS[1]!.title, PUBLIC_CONTENT_ITEMS[0]!.title)
  .replace("__FIRST_TITLE__", PUBLIC_CONTENT_ITEMS[1]!.title)
  .replace(PUBLIC_CONTENT_ITEMS[0]!.canonicalUrl, "__FIRST_URL__")
  .replace(
    PUBLIC_CONTENT_ITEMS[1]!.canonicalUrl,
    PUBLIC_CONTENT_ITEMS[0]!.canonicalUrl,
  )
  .replace("__FIRST_URL__", PUBLIC_CONTENT_ITEMS[1]!.canonicalUrl);

describe("npm release provenance evidence", () => {
  it("requires the exact package, version, repository, directory, and attestation", () => {
    expect(
      npmReleaseHasProvenance(
        VALID_NPM_RELEASE,
        "@openzaps/sdk",
        "0.1.0",
        "packages/sdk",
      ),
    ).toBe(true);

    for (const invalid of [
      { ...VALID_NPM_RELEASE, name: "@openzaps/lookalike" },
      { ...VALID_NPM_RELEASE, version: "0.1.1" },
      {
        ...VALID_NPM_RELEASE,
        repository: { ...VALID_NPM_RELEASE.repository, directory: "packages/mcp" },
      },
      {
        ...VALID_NPM_RELEASE,
        publishConfig: { access: "public", provenance: false },
      },
      {
        ...VALID_NPM_RELEASE,
        dist: { ...VALID_NPM_RELEASE.dist, attestations: undefined },
      },
      {
        ...VALID_NPM_RELEASE,
        dist: { ...VALID_NPM_RELEASE.dist, integrity: "sha512-YWJjZA==" },
      },
      {
        ...VALID_NPM_RELEASE,
        dist: {
          ...VALID_NPM_RELEASE.dist,
          attestations: {
            ...VALID_NPM_RELEASE.dist.attestations,
            url: "https://registry.npmjs.org/-/npm/v1/attestations/@openzaps%2fmcp@0.1.0",
          },
        },
      },
    ]) {
      expect(
        npmReleaseHasProvenance(
          invalid,
          "@openzaps/sdk",
          "0.1.0",
          "packages/sdk",
        ),
      ).toBe(false);
    }
  });
});

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
  vi.stubEnv(
    "DISCORD_MARKETING_WEBHOOK_URL",
    "https://discord.com/api/webhooks/123/public-token",
  );
  vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
  vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
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

function scheduledRequest(channel: "x" | "discord") {
  return {
    campaignId: "virtual-trading-request-zap-v2",
    channel,
    slotDay: CREATED_AT.slice(0, 10),
    contentHash:
      channel === "x"
        ? "31bc8afd32a05563745a85b55a8ae267fda72da5c9cef4b3b63378b14cf53961"
        : "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
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

function substackBundle(): MarketingDraftBundle {
  const base = bundle();
  const candidate = {
    ...base.candidates[0],
    id: "draft:abc:substack",
    channel: "substack" as const,
    action: "prepare_tutorial" as const,
    kind: "tutorial" as const,
    body: [
      "# Give the agent the trigger, never the authority",
      "",
      "OpenZaps keeps execution bounded by terms the owner commits before an agent can submit a due action. ".repeat(4),
      "",
      "Pre-audit software. Verify before use.",
      "",
      "Review the exact authority boundary at https://www.0xzaps.com/docs before using a live workflow.",
    ].join("\n"),
    links: ["https://www.0xzaps.com/docs"],
  };
  return {
    ...base,
    request: {
      kind: "tutorial",
      brief: "Explain bounded agent authority in a verified tutorial.",
      channels: ["substack"],
      sourceUrls: [],
    },
    candidates: [candidate],
    presentations: [{
      candidateId: candidate.id,
      channel: "substack",
      title: "Give the Agent the Trigger, Never the Authority",
      subtitle: "A source-backed guide to bounded agent execution",
      tags: ["OpenZaps", "DeFi"],
    }],
    policy: [{
      ...base.policy[0],
      candidateId: candidate.id,
      riskTier: 2,
      approvalReasons: ["every_run_human_approval", "tutorial"],
      dailyCounter: "substackTutorials",
    }],
  };
}

beforeEach(() => {
  mocks.verifyCampaignClaim.mockResolvedValue(true);
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

  it("creates one approved Substack editor handoff and replays it without a network write", async () => {
    setLiveEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.claim
      .mockResolvedValueOnce({
        result: "claimed",
        status: "claimed",
        currentCount: 1,
        day: zeroSnapshot().usage.day,
      })
      .mockResolvedValueOnce({
        result: "already_claimed",
        status: "requires_human_publish",
        currentCount: 1,
        day: zeroSnapshot().usage.day,
        providerMessageId: null,
        providerUrl: "https://defitutorials.substack.com/publish/post",
        failureCode: null,
        claimedAt: CREATED_AT,
        completedAt: CREATED_AT,
      });
    mocks.complete.mockResolvedValue({
      result: "finalized",
      status: "requires_human_publish",
    });
    const reviewedBundle = substackBundle();
    const approval = {
      decision: "approve" as const,
      approvedBy: "Nodar",
    };

    await expect(
      publishMarketingBundleStep(reviewedBundle, approval),
    ).resolves.toEqual([{
      channel: "substack",
      candidateId: "draft:abc:substack",
      status: "requires_human_publish",
      idempotencyKey: "draft:abc:substack",
      editorUrl: "https://defitutorials.substack.com/publish/post",
    }]);
    expect(mocks.claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "draft:abc:substack",
        candidateId: "draft:abc:substack",
        channel: "substack",
        action: "prepare_tutorial",
        approvedBy: "Nodar",
        dailyCap: 1,
      }),
    );
    expect(mocks.complete).toHaveBeenCalledWith({
      idempotencyKey: "draft:abc:substack",
      channel: "substack",
      action: "prepare_tutorial",
      status: "requires_human_publish",
      providerUrl: "https://defitutorials.substack.com/publish/post",
    });

    await expect(
      publishMarketingBundleStep(reviewedBundle, approval),
    ).resolves.toEqual([{
      channel: "substack",
      candidateId: "draft:abc:substack",
      status: "requires_human_publish",
      idempotencyKey: "draft:abc:substack",
      editorUrl: "https://defitutorials.substack.com/publish/post",
    }]);

    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
    expect(mocks.xReply).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
    expect(mocks.discordWebhook).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("never auto-publishes the externally fulfilled X campaign", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());

    const draft = await buildScheduledMarketingDraftStep(
      scheduledRequest("x"),
      scheduledSourcePacket(),
      "scheduled-run-1",
    );
    expect(draft.model).toBe(
      "deterministic/reviewed-campaign/virtual-trading-request-zap-v2/x",
    );
    expect(draft.policy).toEqual([
      expect.objectContaining({
        disposition: "require_approval",
        riskTier: 1,
        approvalRequired: true,
        approvalReasons: ["every_run_human_approval"],
      }),
    ]);
    expect(mocks.generateText).not.toHaveBeenCalled();

    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([{ status: "blocked" }]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.xBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a direct scheduled invocation without a current durable queue claim", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyCampaignClaim.mockResolvedValue(false);

    await expect(
      buildScheduledMarketingDraftStep(
        scheduledRequest("discord"),
        scheduledSourcePacket(),
        "scheduled-run-without-claim",
      ),
    ).rejects.toThrow("matching durable claim");

    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it("rechecks volatile evidence after provider preflight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CREATED_AT));
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyDiscordDestination.mockImplementation(async () => {
      vi.setSystemTime(
        new Date(
          Date.parse(CREATED_AT)
            + MAX_VOLATILE_MARKETING_SOURCE_AGE_MS
            + 1,
        ),
      );
    });

    const draft = await buildScheduledMarketingDraftStep(
      scheduledRequest("discord"),
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
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it.each([
    ["is no longer current", false],
    ["is unavailable", new Error("campaign claim verification unavailable")],
  ])(
    "blocks when the final durable campaign claim %s",
    async (_case, finalVerification) => {
      setLiveEnvironment();
      vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
      vi.stubEnv(
        "DISCORD_MARKETING_WEBHOOK_URL",
        "https://discord.com/api/webhooks/123/public-token",
      );
      vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
      vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
      mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
      mocks.verifyCampaignClaim
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      if (finalVerification instanceof Error) {
        mocks.verifyCampaignClaim.mockRejectedValueOnce(finalVerification);
      } else {
        mocks.verifyCampaignClaim.mockResolvedValueOnce(finalVerification);
      }

      const draft = await buildScheduledMarketingDraftStep(
        scheduledRequest("discord"),
        scheduledSourcePacket(),
        "scheduled-run-final-claim-check",
      );
      await expect(
        publishScheduledMarketingBundleStep(draft),
      ).resolves.toMatchObject([
        {
          channel: "discord",
          status: "blocked",
          error: expect.stringContaining(
            finalVerification instanceof Error
              ? "verification was unavailable"
              : "no longer current",
          ),
        },
      ]);

      expect(mocks.verifyDiscordDestination).not.toHaveBeenCalled();
      expect(mocks.verifyCampaignClaim).toHaveBeenCalledTimes(3);
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.discord).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it("rechecks the durable campaign claim immediately before delivery admission", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    vi.stubEnv(
      "DISCORD_MARKETING_WEBHOOK_URL",
      "https://discord.com/api/webhooks/123/public-token",
    );
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
    vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    mocks.verifyCampaignClaim
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const draft = await buildScheduledMarketingDraftStep(
      scheduledRequest("discord"),
      scheduledSourcePacket(),
      "scheduled-run-immediate-claim-check",
    );
    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([
      {
        channel: "discord",
        status: "blocked",
        error: expect.stringContaining("no longer current"),
      },
    ]);

    expect(mocks.verifyDiscordDestination).toHaveBeenCalledOnce();
    expect(mocks.verifyCampaignClaim).toHaveBeenCalledTimes(4);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
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
      scheduledRequest("discord"),
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
      scheduledRequest("discord"),
      scheduledSourcePacket(),
      "scheduled-run-1",
    );
    const second = await buildScheduledMarketingDraftStep(
      scheduledRequest("discord"),
      scheduledSourcePacket(),
      "scheduled-run-2",
    );
    expect(second.id).toBe(first.id);

    await expect(
      publishScheduledMarketingBundleStep(second),
    ).resolves.toMatchObject([
      {
        channel: "discord",
        status: "blocked",
        error: expect.stringContaining("idempotency_conflict"),
      },
    ]);

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "scheduled:virtual-trading-request-zap-v2:discord",
      }),
    );
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it("blocks scheduled body, claim, and evidence tampering before a provider write", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    const draft = await buildScheduledMarketingDraftStep(
      scheduledRequest("discord"),
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
    expect(mocks.discord).not.toHaveBeenCalled();
  });

  it("rechecks the automatic authority immediately before durable admission", async () => {
    setLiveEnvironment();
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
    mocks.getSnapshot.mockResolvedValue(zeroSnapshot());
    const draft = await buildScheduledMarketingDraftStep(
      scheduledRequest("discord"),
      scheduledSourcePacket(),
      "scheduled-run-1",
    );

    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "false");
    await expect(
      publishScheduledMarketingBundleStep(draft),
    ).resolves.toMatchObject([{ status: "blocked" }]);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.discord).not.toHaveBeenCalled();
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
      if (input.endsWith("/docs")) {
        return Promise.resolve(
          new Response(
            "@openzaps/sdk@0.1.0 @openzaps/mcp@0.1.0 read-only Agent Kit can discover capsules no signing or broadcast method Stays with your wallet or Safe. Lives inside the immutable policy",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
        );
      }
      if (input.endsWith("/learn")) {
        return Promise.resolve(
          new Response(LEARN_PAGE_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }
      if (input.includes("@openzaps%2fsdk/0.1.0")) {
        return Promise.resolve(
          Response.json({
            ...VALID_NPM_RELEASE,
          }),
        );
      }
      if (input.includes("@openzaps%2fmcp/0.1.0")) {
        return Promise.resolve(
          Response.json({
            ...VALID_NPM_RELEASE,
            name: "@openzaps/mcp",
            repository: {
              ...VALID_NPM_RELEASE.repository,
              directory: "packages/mcp",
            },
            dist: {
              ...VALID_NPM_RELEASE.dist,
              attestations: {
                ...VALID_NPM_RELEASE.dist.attestations,
                url: "https://registry.npmjs.org/-/npm/v1/attestations/@openzaps%2fmcp@0.1.0",
              },
            },
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

    expect(fetchMock).toHaveBeenCalledTimes(12);
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
        expect.objectContaining({
          key: "product.agent_kit_sdk_release",
          status: "confirmed",
          sourceUrl:
            "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0",
        }),
        expect.objectContaining({
          key: "product.agent_kit_mcp_release",
          status: "confirmed",
          sourceUrl:
            "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0",
        }),
        expect.objectContaining({
          key: "product.agent_kit_boundaries",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/docs",
        }),
        expect.objectContaining({
          key: "product.learn_hub",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/learn",
        }),
      ]),
    );
  });

  it.each([
    [
      "catalog digest drift",
      LEARN_PAGE_HTML.replace(PUBLIC_CONTENT_CATALOG_DIGEST, "0".repeat(64)),
    ],
    [
      "missing rendered identity",
      LEARN_PAGE_HTML.replace(
        ` data-public-content-id="${PUBLIC_CONTENT_ITEMS[0]!.id}"`,
        "",
      ),
    ],
    [
      "withheld tutorial exposure",
      LEARN_PAGE_HTML.replace(
        "</main>",
        `${NON_PUBLIC_TUTORIAL_TITLES[0]!}</main>`,
      ),
    ],
    ["swapped card content", SWAPPED_LEARN_CARD_HTML],
  ])("rejects Learn evidence with %s", async (_label, learnHtml) => {
    const fetchMock = vi.fn().mockImplementation((input: string) =>
      Promise.resolve(
        input.endsWith("/learn")
          ? new Response(learnHtml, {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : Response.json({}),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMarketingSourcesStep({
      kind: "product_update",
      brief: "Collect a verified product update.",
      channels: ["x"],
      sourceUrls: [],
    });
    const learnFact = result.facts.find(
      (fact) => fact.key === "product.learn_hub",
    );

    expect(learnFact).toMatchObject({ status: "unavailable", value: null });
    expect(fetchMock).toHaveBeenCalledTimes(12);
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

    expect(fetchMock).toHaveBeenCalledTimes(12);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.redirect).toBe("error");
    }
    expect(cancelled).toHaveBeenCalledTimes(8);
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
      if (input.endsWith("/docs")) {
        return Promise.resolve(
          new Response("Agent Kit docs", {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (input.startsWith("https://registry.npmjs.org/")) {
        return Promise.resolve(Response.json({}));
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

    expect(fetchMock).toHaveBeenCalledTimes(13);
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
      if (input.endsWith("/docs")) {
        return Promise.resolve(
          new Response("Agent Kit docs", {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (input.startsWith("https://registry.npmjs.org/")) {
        return Promise.resolve(Response.json({}));
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

    expect(fetchMock).toHaveBeenCalledTimes(13);
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

  it("requires the exact attributed link in both reviewed body and metadata", async () => {
    const input = bundle();
    const sourceUrl = "https://www.0xzaps.com/virtual-trading";
    const attributedUrl =
      `${sourceUrl}?utm_source=x&utm_medium=social&utm_campaign=virtual-trading&utm_content=feed_update`;
    const request = {
      ...input.request,
      sourceUrls: [sourceUrl],
      requiredChannelLinks: { x: attributedUrl },
    };
    const draft = {
      channel: "x" as const,
      body: `Tracked update. Pre-audit software. Verify before use. ${attributedUrl}`,
      links: [attributedUrl],
      claims: [{
        text: "The update is live.",
        factKeys: ["release_status"],
        treatment: "asserted" as const,
      }],
      topics: ["protocol" as const],
      title: null,
      subtitle: null,
      tags: null,
    };
    mocks.generateText.mockResolvedValueOnce({
      output: { items: [draft] },
      usage: {},
    });

    const result = await generateMarketingDraftStep(
      request,
      input.sourcePacket,
      input.runId,
    );

    expect(result.candidates[0]).toMatchObject({
      body: expect.stringContaining(attributedUrl),
      links: [attributedUrl],
    });
    expect(mocks.generateText.mock.calls[0]?.[0]?.prompt).toContain(
      `include this exact URL verbatim in both the public body and links array: ${attributedUrl}`,
    );

    mocks.generateText.mockResolvedValueOnce({
      output: {
        items: [{
          ...draft,
          body: "Tracked update. Pre-audit software. Verify before use.",
          links: [sourceUrl],
        }],
      },
      usage: {},
    });
    await expect(generateMarketingDraftStep(
      request,
      input.sourcePacket,
      input.runId,
    )).rejects.toThrow(
      "The model omitted an exact required channel attribution link.",
    );

    mocks.generateText.mockResolvedValueOnce({
      output: {
        items: [{
          ...draft,
          body: `Tracked update. Pre-audit software. ${attributedUrl}&utm_campaign=other`,
        }],
      },
      usage: {},
    });
    await expect(generateMarketingDraftStep(
      request,
      input.sourcePacket,
      input.runId,
    )).rejects.toThrow(
      "The model omitted an exact required channel attribution link.",
    );
  });

  it("asks X-only tutorial syndication for social copy, not a new article", async () => {
    const input = bundle();
    const request = {
      ...input.request,
      kind: "tutorial" as const,
      channels: ["x" as const],
    };
    mocks.generateText.mockResolvedValueOnce({
      output: {
        items: [{
          channel: "x",
          body: "A concise tutorial update. Pre-audit software. Verify before use.",
          links: ["https://www.0xzaps.com/docs"],
          claims: [{
            text: "The tutorial covers bounded execution.",
            factKeys: ["release_status"],
            treatment: "asserted",
          }],
          topics: ["protocol"],
          title: null,
          subtitle: null,
          tags: null,
        }],
      },
      usage: {},
    });

    await generateMarketingDraftStep(request, input.sourcePacket, input.runId);

    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain("Syndicate the already-public tutorial");
    expect(prompt).not.toContain("For Substack, write");
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
