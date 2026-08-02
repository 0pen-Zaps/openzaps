import { describe, expect, it } from "vitest";

import { readMarketingConfig } from "@/lib/marketing/config";
import {
  CANONICAL_OUTBOUND_HOSTS,
  MAX_VOLATILE_MARKETING_SOURCE_AGE_MS,
  PRE_AUDIT_DISCLOSURE,
  MAX_MARKETING_SOURCE_AGE_MS,
  UNAVAILABLE_DATA_DISCLOSURE,
  canTransitionMarketingRun,
  classifyMarketingRisk,
  evaluateMarketingPolicy,
  isCanonicalOutboundUrl,
} from "@/lib/marketing/policy";
import {
  reviewedMarketingCampaign,
  scheduledMarketingTemplate,
} from "@/lib/marketing/scheduled-template";
import {
  MarketingCandidateSchema,
  MarketingConfigSchema,
  MarketingPolicyDecisionSchema,
  MarketingRiskTierSchema,
  MarketingRunStateSchema,
} from "@/lib/marketing/schemas";
import type {
  MarketingCandidate,
  MarketingConfig,
  MarketingPolicyContext,
  MarketingPolicyFlags,
} from "@/lib/marketing/types";
import {
  SCHEDULED_MARKETING_TEMPLATE_ID,
  SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
} from "@/lib/marketing/types";

const NOW = "2026-07-29T12:00:00.000Z";
const DAY = "2026-07-29";

const SAFE_FLAGS: MarketingPolicyFlags = {
  containsCredential: false,
  guaranteesReturns: false,
  impersonatesPerson: false,
  requestsPolicyBypass: false,
  unsolicitedBulkMessaging: false,
  usesUnavailableAsZero: false,
};

function reviewConfig(overrides: Partial<MarketingConfig> = {}): MarketingConfig {
  const config = readMarketingConfig({
    OPENZAPS_MARKETING_ENABLED: "true",
    OPENZAPS_MARKETING_DRY_RUN: "false",
    OPENZAPS_MARKETING_AUTO_PUBLISH: "false",
    OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
    OPENZAPS_X_AI_REPLY_APPROVED: "false",
    OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
    OPENZAPS_MARKETING_DM_ENABLED: "true",
    X_USER_ACCESS_TOKEN: "token",
    X_EXPECTED_ACCOUNT_ID: "100",
    X_EXPECTED_USERNAME: "0xzaps",
    DISCORD_MARKETING_WEBHOOK_URL: "https://discord.example/webhook",
    DISCORD_APPLICATION_PUBLIC_KEY: "public-key",
    OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  });
  return { ...config, ...overrides };
}

function candidate(overrides: Partial<MarketingCandidate> = {}): MarketingCandidate {
  const base: MarketingCandidate = {
    id: "candidate-1",
    channel: "x",
    action: "broadcast",
    kind: "product_update",
    topics: ["protocol"],
    body: `A source-backed OpenZaps update. ${PRE_AUDIT_DISCLOSURE} https://www.0xzaps.com/zap`,
    links: ["https://www.0xzaps.com/zap"],
    disclosures: ["pre_audit"],
    claims: [{ text: "The update is live.", factKeys: ["release_status"], treatment: "asserted" }],
    sourcePacket: {
      id: "packet-1",
      createdAt: NOW,
      protocolPreAudit: true,
      externalData: [],
      interaction: null,
      facts: [
        {
          key: "release_status",
          label: "Release status",
          value: "live",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/api/health",
          observedAt: NOW,
        },
      ],
    },
    interaction: null,
    flags: SAFE_FLAGS,
  };
  return { ...base, ...overrides };
}

function context(overrides: Partial<MarketingPolicyContext> = {}): MarketingPolicyContext {
  return {
    now: NOW,
    config: reviewConfig(),
    usage: {
      day: DAY,
      counts: { xPosts: 0, xReplies: 0, discordPosts: 0, substackTutorials: 0, directMessages: 0 },
    },
    humanApproved: false,
    repliedInteractionIds: [],
    ...overrides,
  };
}

function scheduledCandidate(
  overrides: Partial<MarketingCandidate> = {},
): MarketingCandidate {
  const template = scheduledMarketingTemplate("discord");
  const draft = candidate({
    channel: "discord",
    body: template.body,
    links: template.links,
    topics: template.topics,
    disclosures: template.disclosures,
    claims: template.claims,
    flags: template.flags,
  });
  return {
    ...draft,
    sourcePacket: {
      ...draft.sourcePacket,
      facts: [
        {
          key: "product.virtual_trading",
          label: "Virtual Trading",
          value:
            "Browser-local paper trading starts with 10,000 virtual USDG without a wallet, approval, signature, transaction, or real funds.",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/virtual-trading",
          observedAt: NOW,
        },
        {
          key: "product.virtual_trading_markets",
          label: "Virtual Trading market marks",
          value:
            "Current read-only canonical-head marks are available for the deployed 0xZAPS/USDG and aeWETH/USDG routes.",
          status: "confirmed",
          sourceUrl:
            "https://www.0xzaps.com/api/virtual-trading/markets",
          observedAt: NOW,
        },
        {
          key: "product.virtual_trading_quote",
          label: "Virtual Trading quote readiness",
          value:
            "The read-only paper-trade quote endpoint returned a fresh canonical-head quote without a wallet or transaction.",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/api/virtual-trading/quote",
          observedAt: NOW,
        },
        {
          key: "product.request_a_zap",
          label: "Request a Zap page",
          value:
            "The Request a Zap page describes a human-reviewed authority map for one workflow; the review is not an automatic deployment promise.",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/request-a-zap",
          observedAt: NOW,
        },
        {
          key: "product.request_a_zap_intake",
          label: "Request a Zap intake readiness",
          value:
            "The non-mutating readiness probe confirmed authenticated access to the deployed lead-intake RPC.",
          status: "confirmed",
          sourceUrl: "https://www.0xzaps.com/api/leads/request",
          observedAt: NOW,
        },
      ],
    },
    ...overrides,
  };
}

describe("bounded marketing state and risk", () => {
  it("accepts only finite workflow states and risk tiers 0 through 4", () => {
    expect(MarketingRunStateSchema.safeParse("published").success).toBe(true);
    expect(MarketingRunStateSchema.safeParse("whatever").success).toBe(false);
    for (const tier of [0, 1, 2, 3, 4]) expect(MarketingRiskTierSchema.safeParse(tier).success).toBe(true);
    expect(MarketingRiskTierSchema.safeParse(-1).success).toBe(false);
    expect(MarketingRiskTierSchema.safeParse(5).success).toBe(false);
  });

  it("allows only explicit forward state transitions", () => {
    expect(canTransitionMarketingRun("queued", "drafting")).toBe(true);
    expect(canTransitionMarketingRun("policy_check", "awaiting_approval")).toBe(true);
    expect(canTransitionMarketingRun("failed", "policy_check")).toBe(true);
    expect(canTransitionMarketingRun("published", "publishing")).toBe(false);
    expect(canTransitionMarketingRun("rejected", "approved")).toBe(false);
  });

  it("classifies internal, routine, review, sensitive, and prohibited content", () => {
    expect(classifyMarketingRisk(candidate({ action: "draft" }))).toBe(0);
    expect(classifyMarketingRisk(candidate())).toBe(1);
    expect(classifyMarketingRisk(candidate({ topics: ["simulation"] }))).toBe(1);
    expect(classifyMarketingRisk(candidate({ kind: "tutorial" }))).toBe(2);
    expect(classifyMarketingRisk(candidate({ topics: ["security"] }))).toBe(3);
    expect(
      classifyMarketingRisk(candidate({ flags: { ...SAFE_FLAGS, requestsPolicyBypass: true } })),
    ).toBe(4);
  });
});

describe("canonical outbound URLs", () => {
  it("pins the requested canonical destinations", () => {
    expect(CANONICAL_OUTBOUND_HOSTS).toEqual([
      "www.0xzaps.com",
      "0xzaps.com",
      "defitutorials.substack.com",
      "github.com/0pen-Zaps/openzaps",
    ]);
    for (const url of [
      "https://www.0xzaps.com",
      "https://0xzaps.com/zap?view=sign",
      "https://defitutorials.substack.com/p/openzaps",
      "https://github.com/0pen-Zaps/openzaps",
      "https://github.com/0pen-Zaps/openzaps/issues/1",
    ]) {
      expect(isCanonicalOutboundUrl(url), url).toBe(true);
    }
  });

  it("rejects spoofed hosts, insecure URLs, ports, credentials, and other GitHub repos", () => {
    for (const url of [
      "https://0xzaps.com.evil.example",
      "http://0xzaps.com",
      "https://0xzaps.com:8443",
      "https://user:pass@0xzaps.com",
      "https://github.com/0pen-Zaps/other",
      "https://evil.example",
      "not-a-url",
    ]) {
      expect(isCanonicalOutboundUrl(url), url).toBe(false);
    }
  });

  it("scans URLs embedded in rendered text, not only the declared links array", () => {
    const result = evaluateMarketingPolicy(
      candidate({ body: `Update: https://evil.example/path. ${PRE_AUDIT_DISCLOSURE}`, links: [] }),
      context(),
    );

    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain("outbound_url_not_allowlisted");
  });

  it.each([
    "//evil.example/path",
    "[open this](evil.example/path)",
    "[open this](javascript:alert(1))",
    "evil.example/path",
  ])("rejects non-canonical link-like syntax: %s", (target) => {
    const result = evaluateMarketingPolicy(
      candidate({
        body: `Update: ${target} ${PRE_AUDIT_DISCLOSURE}`,
        links: [],
      }),
      context(),
    );

    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "link_syntax_not_canonical",
    );
  });

  it("allows bare canonical destinations and ordinary dotted versions", () => {
    const result = evaluateMarketingPolicy(
      candidate({
        body:
          `OpenZaps v1.2.3 docs: 0xzaps.com/zap and `
          + `github.com/0pen-Zaps/openzaps. ${PRE_AUDIT_DISCLOSURE}`,
        links: [],
      }),
      context(),
    );

    expect(result.issues.map((issue) => issue.code)).not.toContain(
      "link_syntax_not_canonical",
    );
    expect(result.riskTier).toBe(1);
  });

  it("does not misclassify source-packet fact keys as bare domains", () => {
    const baseCandidate = candidate();
    const result = evaluateMarketingPolicy(
      candidate({
        body:
          `Verified by protocol.creation_gate and authority.execution. `
          + PRE_AUDIT_DISCLOSURE,
        links: [],
        sourcePacket: {
          ...baseCandidate.sourcePacket,
          facts: [
            ...baseCandidate.sourcePacket.facts,
            {
              key: "protocol.creation_gate",
              label: "Creation gate",
              value: "open",
              status: "confirmed",
              sourceUrl: "https://www.0xzaps.com/api/health",
              observedAt: NOW,
            },
            {
              key: "authority.execution",
              label: "Execution authority",
              value: "bounded",
              status: "confirmed",
              sourceUrl: "https://www.0xzaps.com/api/health",
              observedAt: NOW,
            },
          ],
        },
      }),
      context(),
    );

    expect(result.issues.map((issue) => issue.code)).not.toContain(
      "link_syntax_not_canonical",
    );
    expect(result.disposition).toBe("require_approval");
  });
});

describe("deterministic marketing policy", () => {
  it("requires review, then allows a source-backed, disclosed, low-risk update", () => {
    expect(evaluateMarketingPolicy(candidate(), context()).disposition).toBe(
      "require_approval",
    );
    const result = evaluateMarketingPolicy(
      candidate(),
      context({ humanApproved: true }),
    );

    expect(result).toMatchObject({
      riskTier: 1,
      disposition: "allow",
      approvalRequired: true,
      requiredDisclosures: ["pre_audit"],
      dailyCounter: "xPosts",
      issues: [],
    });
    expect(MarketingCandidateSchema.safeParse(candidate()).success).toBe(true);
    expect(MarketingPolicyDecisionSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ["tutorial", candidate({ kind: "tutorial" }), 2],
    ["incident", candidate({ kind: "incident_update" }), 3],
    ["security", candidate({ topics: ["security"] }), 3],
    ["token", candidate({ topics: ["token"] }), 3],
    ["trading", candidate({ topics: ["trading"] }), 3],
    ["partnership", candidate({ topics: ["partnership"] }), 2],
    ["roadmap", candidate({ topics: ["roadmap"] }), 2],
    ["new_deployment", candidate({ topics: ["new_deployment"] }), 2],
  ])("requires approval for %s content", (reason, draft, tier) => {
    const result = evaluateMarketingPolicy(draft, context());
    expect(result.riskTier).toBe(tier);
    expect(result.disposition).toBe("require_approval");
    expect(result.approvalReasons).toContain(reason);

    const approved = evaluateMarketingPolicy(draft, context({ humanApproved: true }));
    expect(approved.disposition).toBe("allow");
  });

  it("makes review-only configuration require approval for every outbound item", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "false",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_USER_ACCESS_TOKEN: "token",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/webhooks/123/public-token",
      OPENZAPS_DISCORD_GUILD_ID: "456",
      DISCORD_MARKETING_CHANNEL_ID: "789",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    const result = evaluateMarketingPolicy(candidate(), context({ config }));

    expect(result.disposition).toBe("require_approval");
    expect(result.approvalReasons).toContain("every_run_human_approval");
    expect(evaluateMarketingPolicy(candidate(), context({ config, humanApproved: true })).disposition).toBe("allow");
  });

  it("auto-authorizes only the exact scheduled tier-1 template", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "true",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_USER_ACCESS_TOKEN: "token",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/webhooks/123/public-token",
      OPENZAPS_DISCORD_GUILD_ID: "456",
      DISCORD_MARKETING_CHANNEL_ID: "789",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });

    expect(config.autoPublishRequested).toBe(true);
    expect(config.autoPublish).toBe(true);
    expect(config.readiness.autoPublishReady).toBe(true);
    expect(MarketingConfigSchema.safeParse(config).success).toBe(true);
    expect(
      MarketingConfigSchema.safeParse({
        ...config,
        autoPublish: false,
        mode: "review_only",
      }).success,
    ).toBe(false);

    const automaticContext = context({
      config,
      automaticAuthorization: {
        kind: "scheduled_template",
        templateId: SCHEDULED_MARKETING_TEMPLATE_ID,
      },
    });
    const exact = evaluateMarketingPolicy(
      scheduledCandidate(),
      automaticContext,
    );
    expect(exact).toMatchObject({
      disposition: "allow",
      riskTier: 1,
      approvalRequired: false,
      approvalReasons: [],
    });

    const delayed = evaluateMarketingPolicy(scheduledCandidate(), {
      ...automaticContext,
      now: new Date(
        Date.parse(NOW) + MAX_VOLATILE_MARKETING_SOURCE_AGE_MS + 1,
      ).toISOString(),
    });
    expect(delayed.disposition).toBe("blocked");
    expect(delayed.issues.map((issue) => issue.code)).toContain(
      "volatile_source_stale",
    );

    const reviewedDelayed = evaluateMarketingPolicy(
      scheduledCandidate(),
      context({
        config,
        humanApproved: true,
        now: new Date(
          Date.parse(NOW) + MAX_VOLATILE_MARKETING_SOURCE_AGE_MS + 1,
        ).toISOString(),
      }),
    );
    expect(reviewedDelayed.disposition).toBe("allow");
    expect(reviewedDelayed.issues).toEqual([]);

    const generated = evaluateMarketingPolicy(candidate(), automaticContext);
    expect(generated.disposition).toBe("require_approval");
    expect(generated.approvalReasons).toContain("every_run_human_approval");

    const template = scheduledCandidate();
    const changedBody = evaluateMarketingPolicy(
      { ...template, body: `${template.body} Changed.` },
      automaticContext,
    );
    expect(changedBody.disposition).toBe("require_approval");

    const changedClaims = evaluateMarketingPolicy(
      { ...template, claims: template.claims.slice(0, 1) },
      automaticContext,
    );
    expect(changedClaims.disposition).toBe("require_approval");

    const missingEvidence = evaluateMarketingPolicy(
      {
        ...template,
        sourcePacket: { ...template.sourcePacket, facts: [] },
      },
      automaticContext,
    );
    expect(missingEvidence.disposition).toBe("blocked");
    expect(missingEvidence.issues.map((issue) => issue.code)).toContain(
      "unknown_fact",
    );
  });

  it("requires fresh live evidence for automatic shareable-design delivery", () => {
    const observedAt = "2026-08-07T14:00:00.000Z";
    const campaign = reviewedMarketingCampaign(
      SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
      "discord",
    );
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "true",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_USER_ACCESS_TOKEN: "token",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/webhooks/123/public-token",
      OPENZAPS_DISCORD_GUILD_ID: "456",
      DISCORD_MARKETING_CHANNEL_ID: "789",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    const draft = candidate({
      id: "share-design-discord-policy-test",
      channel: "discord",
      topics: [...campaign.topics],
      body: campaign.body,
      links: [...campaign.links],
      disclosures: [...campaign.disclosures],
      claims: campaign.claims.map((claim) => ({
        ...claim,
        factKeys: [...claim.factKeys],
      })),
      flags: { ...campaign.flags },
      sourcePacket: {
        id: "share-design-discord-policy-source",
        createdAt: observedAt,
        protocolPreAudit: true,
        externalData: [],
        interaction: null,
        facts: campaign.requiredFacts.map((fact) => ({
          key: fact.key,
          label: "Shareable Zap design boundary",
          value: "confirmed",
          status: "confirmed" as const,
          sourceUrl: fact.sourceUrl,
          observedAt,
        })),
      },
    });
    const automaticContext = context({
      now: observedAt,
      config,
      usage: {
        day: "2026-08-07",
        counts: {
          xPosts: 0,
          xReplies: 0,
          discordPosts: 0,
          substackTutorials: 0,
          directMessages: 0,
        },
      },
      automaticAuthorization: {
        kind: "scheduled_template",
        templateId: SHARE_ZAP_DESIGN_MARKETING_CAMPAIGN_ID,
      },
    });

    expect(evaluateMarketingPolicy(draft, automaticContext).disposition).toBe(
      "allow",
    );

    const stale = evaluateMarketingPolicy(draft, {
      ...automaticContext,
      now: new Date(
        Date.parse(observedAt) + MAX_VOLATILE_MARKETING_SOURCE_AGE_MS + 1,
      ).toISOString(),
    });
    expect(stale.disposition).toBe("blocked");
    expect(stale.issues.map((issue) => issue.code)).toContain(
      "volatile_source_stale",
    );
  });

  it("hard-prohibits tier 4 even when a human approval bit is present", () => {
    const unsafe = candidate({
      flags: { ...SAFE_FLAGS, guaranteesReturns: true },
      body: `Guaranteed returns. ${PRE_AUDIT_DISCLOSURE}`,
    });
    const result = evaluateMarketingPolicy(unsafe, context({ humanApproved: true }));

    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain("guaranteed_returns");
  });

  it("detects credential-like text even if a model left the flag false", () => {
    const leaked = candidate({
      action: "draft",
      body: `Use sk-proj-${"a".repeat(40)} for setup.`,
      disclosures: [],
    });
    const result = evaluateMarketingPolicy(leaked, context({ humanApproved: true }));

    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain("credential_exposure");
  });

  it.each([
    "Webhook https://discord.com/api/webhooks/123456789/example-secret-token",
    "-----BEGIN PRIVATE KEY-----\nnot-for-publication",
    "Bearer abcdefghijklmnopqrstuvwxyz123456",
    "https://www.0xzaps.com/docs?access_token=redacted",
    "https://defitutorials.substack.com/p/openzaps#signature=redacted",
  ])("prohibits broader credential-like public content: %s", (leakedValue) => {
    const leaked = candidate({
      action: "draft",
      body: `Do not publish ${leakedValue}`,
      links: leakedValue.startsWith("https://") ? [leakedValue] : [],
      disclosures: [],
    });
    const result = evaluateMarketingPolicy(
      leaked,
      context({ humanApproved: true }),
    );

    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "credential_exposure",
    );
  });

  it("requires both the disclosure marker and disclosure text for pre-audit software", () => {
    const missingMarker = evaluateMarketingPolicy(
      candidate({ disclosures: [], body: "A product update." }),
      context(),
    );
    expect(missingMarker.disposition).toBe("blocked");
    expect(missingMarker.issues.map((issue) => issue.code)).toContain("missing_disclosure_marker");

    const missingText = evaluateMarketingPolicy(candidate({ body: "A product update." }), context());
    expect(missingText.disposition).toBe("blocked");
    expect(missingText.issues.map((issue) => issue.code)).toContain("missing_disclosure_text");
  });

  it("keeps unavailable values null and requires an unknown-not-zero disclosure", () => {
    const draft = candidate({
      body: `History is currently unavailable. ${PRE_AUDIT_DISCLOSURE} ${UNAVAILABLE_DATA_DISCLOSURE}`,
      disclosures: ["pre_audit", "unavailable_not_zero"],
      claims: [{ text: "History is unavailable.", factKeys: ["history"], treatment: "qualified" }],
      sourcePacket: {
        ...candidate().sourcePacket,
        facts: [
          {
            key: "history",
            label: "History",
            value: null,
            status: "unavailable",
            sourceUrl: "https://www.0xzaps.com/api/protocol/pot",
            observedAt: NOW,
          },
        ],
      },
    });

    expect(
      evaluateMarketingPolicy(draft, context({ humanApproved: true }))
        .disposition,
    ).toBe("allow");

    const zero = {
      ...draft,
      sourcePacket: { ...draft.sourcePacket, facts: [{ ...draft.sourcePacket.facts[0], value: 0 }] },
    } as MarketingCandidate;
    const result = evaluateMarketingPolicy(zero, context({ humanApproved: true }));
    expect(result.riskTier).toBe(4);
    expect(result.disposition).toBe("prohibited");
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_unavailable_fact");
  });

  it("does not burden copy with an unrelated unavailable fact", () => {
    const draft = candidate({
      sourcePacket: {
        ...candidate().sourcePacket,
        facts: [
          ...candidate().sourcePacket.facts,
          {
            key: "unrelated.history",
            label: "Unrelated history",
            value: null,
            status: "unavailable",
            sourceUrl: "https://www.0xzaps.com/api/protocol/pot",
            observedAt: NOW,
          },
        ],
      },
    });

    const result = evaluateMarketingPolicy(
      draft,
      context({ humanApproved: true }),
    );
    expect(result.disposition).toBe("allow");
    expect(result.requiredDisclosures).toEqual(["pre_audit"]);
  });

  it("blocks unsupported and over-asserted claims", () => {
    const unknown = evaluateMarketingPolicy(
      candidate({ claims: [{ text: "Unverified claim.", factKeys: ["missing"], treatment: "asserted" }] }),
      context(),
    );
    expect(unknown.issues.map((issue) => issue.code)).toContain("unknown_fact");

    const inferred = candidate({
      claims: [{ text: "Likely.", factKeys: ["release_status"], treatment: "asserted" }],
      sourcePacket: {
        ...candidate().sourcePacket,
        facts: [{ ...candidate().sourcePacket.facts[0], status: "inference" }],
      },
    });
    expect(evaluateMarketingPolicy(inferred, context()).issues.map((issue) => issue.code)).toContain(
      "unconfirmed_claim_asserted",
    );
  });

  it("runs safely in dry-run without channel credentials, but never publishes", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
    });
    const result = evaluateMarketingPolicy(candidate(), context({ config }));

    expect(result.disposition).toBe("dry_run");
    expect(config.readiness.channels.x).toBe(false);
  });

  it("fails closed when the agent is disabled", () => {
    const result = evaluateMarketingPolicy(candidate(), context({ config: readMarketingConfig({}) }));
    expect(result.disposition).toBe("blocked");
    expect(result.issues.map((issue) => issue.code)).toContain("configuration_unready");
  });

  it("blocks at daily caps and when the counter window is stale", () => {
    const atCap = context({
      usage: {
        day: DAY,
        counts: { xPosts: 2, xReplies: 0, discordPosts: 0, substackTutorials: 0, directMessages: 0 },
      },
    });
    expect(evaluateMarketingPolicy(candidate(), atCap).issues.map((issue) => issue.code)).toContain(
      "daily_cap_reached",
    );

    const stale = context({ usage: { ...context().usage, day: "2026-07-28" } });
    expect(evaluateMarketingPolicy(candidate(), stale).issues.map((issue) => issue.code)).toContain(
      "daily_usage_window_invalid",
    );
  });

  it("expires approval when source evidence is too old or materially future-dated", () => {
    const stale = evaluateMarketingPolicy(
      candidate(),
      context({
        now: new Date(
          Date.parse(NOW) + MAX_MARKETING_SOURCE_AGE_MS + 1,
        ).toISOString(),
        humanApproved: true,
      }),
    );
    const future = evaluateMarketingPolicy(
      candidate(),
      context({
        now: new Date(Date.parse(NOW) - 5 * 60 * 1_000 - 1).toISOString(),
        humanApproved: true,
      }),
    );

    expect(stale.disposition).toBe("blocked");
    expect(future.disposition).toBe("blocked");
    expect(stale.issues.map((issue) => issue.code)).toContain(
      "source_packet_stale",
    );
    expect(future.issues.map((issue) => issue.code)).toContain(
      "source_packet_stale",
    );
  });

  it("supports only the human-approved Substack handoff, never direct API publishing", () => {
    const tutorial = candidate({
      channel: "substack",
      action: "prepare_tutorial",
      kind: "tutorial",
      links: ["https://defitutorials.substack.com"],
      body: `Tutorial draft. ${PRE_AUDIT_DISCLOSURE} https://defitutorials.substack.com`,
    });

    expect(evaluateMarketingPolicy(tutorial, context()).disposition).toBe("require_approval");
    expect(evaluateMarketingPolicy(tutorial, context({ humanApproved: true })).disposition).toBe("allow");

    const direct = evaluateMarketingPolicy(
      { ...tutorial, action: "publish_tutorial" },
      context({ humanApproved: true }),
    );
    expect(direct.disposition).toBe("blocked");
    expect(direct.issues.map((issue) => issue.code)).toContain("substack_direct_publish_unsupported");
  });

  it("fails closed for future channels until reviewed adapters exist", () => {
    for (const channel of ["farcaster", "github"] as const) {
      const result = evaluateMarketingPolicy(candidate({ channel }), context({ humanApproved: true }));
      expect(result.disposition).toBe("blocked");
      expect(result.issues.map((issue) => issue.code)).toContain(`${channel}_not_ready`);
    }
  });

  it("keeps direct messages blocked even when the legacy gate is requested", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "false",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_MARKETING_DM_ENABLED: "true",
      X_USER_ACCESS_TOKEN: "token",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    const directMessage = candidate({ action: "direct_message" });
    const result = evaluateMarketingPolicy(directMessage, context({ config, humanApproved: true }));

    expect(result.approvalRequired).toBe(true);
    expect(result.disposition).toBe("blocked");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "direct_messages_unsupported",
    );
  });

  it("keeps Discord replies on the deterministic slash-command surface", () => {
    const result = evaluateMarketingPolicy(
      candidate({
        channel: "discord",
        action: "reply",
      }),
      context({ humanApproved: true }),
    );

    expect(result.disposition).toBe("blocked");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "discord_replies_unsupported",
    );
  });
});

describe("X reply gates", () => {
  function verifiedInteraction(trigger: "mention" | "quote" = "mention") {
    return {
      id: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger,
      observedAt: NOW,
    };
  }

  function reply(trigger: "mention" | "quote" = "mention"): MarketingCandidate {
    const interaction = verifiedInteraction(trigger);
    const draft = candidate({
      action: "reply",
      kind: "community_reply",
      interaction,
    });
    return {
      ...draft,
      sourcePacket: { ...draft.sourcePacket, interaction },
    };
  }

  it("requires the explicit X policy-approval environment gate", () => {
    const config = reviewConfig({ xAiReplyApproved: false });
    const result = evaluateMarketingPolicy(reply(), context({ config }));

    expect(result.disposition).toBe("blocked");
    expect(result.issues.map((issue) => issue.code)).toContain("x_ai_reply_approval_missing");
  });

  it("allows a side-effect-free verified reply draft while every X write gate is off", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
      X_USER_ACCESS_TOKEN: "read-capable-user-token",
    });
    const result = evaluateMarketingPolicy(reply(), context({ config }));

    expect(config.readiness.channels.x).toBe(false);
    expect(config.xAiReplyApproved).toBe(false);
    expect(result.disposition).toBe("dry_run");
    expect(result.issues).toEqual([]);
  });

  it("requires immutable API verification evidence", () => {
    const result = evaluateMarketingPolicy(
      { ...reply(), interaction: null },
      context(),
    );

    expect(result.disposition).toBe("blocked");
    expect(result.issues.map((issue) => issue.code)).toContain("x_reply_not_explicitly_summoned");

    const mismatch = evaluateMarketingPolicy(
      { ...reply(), interaction: verifiedInteraction("quote") },
      context(),
    );
    expect(mismatch.issues.map((issue) => issue.code)).toContain(
      "x_reply_verification_mismatch",
    );
  });

  it("permits one reply only under verified config and blocks durable duplicates", () => {
    const verifiedConfig = reviewConfig({
      xAiReplyApproved: true,
      xAutomatedLabelConfirmed: true,
    });
    expect(
      evaluateMarketingPolicy(
        reply(),
        context({ config: verifiedConfig, humanApproved: true }),
      )
        .disposition,
    ).toBe("allow");

    expect(
      evaluateMarketingPolicy(
        reply(),
        context({
          config: verifiedConfig,
          repliedInteractionIds: ["123456789"],
        }),
      ).issues.map((issue) => issue.code),
    ).toContain("x_interaction_already_replied");
  });
});
