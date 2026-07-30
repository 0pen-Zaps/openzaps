import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeployedMarketingCandidateSchema,
  GeneratedChannelDraftSchema,
  GeneratedMarketingDraftSchema,
  MarketingApprovalPayloadSchema,
  MarketingDraftBundleSchema,
  MarketingDraftRequestSchema,
  MarketingScheduledRequestSchema,
} from "@/workflows/marketing-agent/contracts";

describe("marketing workflow request contracts", () => {
  it("normalizes one valid, source-backed product request", () => {
    expect(
      MarketingDraftRequestSchema.parse({
        kind: "product_update",
        brief: "Explain the verified bounded-authority release.",
        channels: ["x", "discord"],
      }),
    ).toEqual({
      kind: "product_update",
      brief: "Explain the verified bounded-authority release.",
      channels: ["x", "discord"],
      sourceUrls: [],
    });
  });

  it("rejects duplicate channels and unreviewed source origins", () => {
    expect(
      MarketingDraftRequestSchema.safeParse({
        kind: "product_update",
        brief: "Explain a verified product update.",
        channels: ["x", "x"],
        sourceUrls: ["https://attacker.example/instructions"],
      }).success,
    ).toBe(false);
  });

  it("keeps scheduled authority to the server-only X and Discord surface", () => {
    expect(
      MarketingScheduledRequestSchema.parse({
        channels: ["discord", "x"],
      }),
    ).toEqual({ channels: ["discord", "x"] });
    expect(
      MarketingScheduledRequestSchema.safeParse({
        channels: ["discord", "discord"],
      }).success,
    ).toBe(false);
    expect(
      MarketingScheduledRequestSchema.safeParse({
        channels: ["substack"],
      }).success,
    ).toBe(false);
    expect(
      MarketingScheduledRequestSchema.safeParse({
        channels: ["discord"],
        templateId: "caller-selected-template",
      }).success,
    ).toBe(false);
  });

  it("normalizes safe source URLs and rejects credential-like query or fragment data", () => {
    const credentialLikeValue = [
      "abcdefgh",
      "ijklmnop",
      "qrstuvwx",
      "yz123456",
    ].join("");

    expect(
      MarketingDraftRequestSchema.parse({
        kind: "product_update",
        brief: "Explain a verified product update.",
        channels: ["x"],
        sourceUrls: ["https://www.0xzaps.com/docs?view=security#current-gates"],
      }).sourceUrls,
    ).toEqual(["https://www.0xzaps.com/docs?view=security"]);

    for (const sourceUrl of [
      `https://www.0xzaps.com/docs?api_key=${credentialLikeValue}`,
      `https://github.com/0pen-Zaps/openzaps#sk-proj-${"a".repeat(40)}`,
    ]) {
      const parsed = MarketingDraftRequestSchema.safeParse({
        kind: "product_update",
        brief: "Explain a verified product update.",
        channels: ["x"],
        sourceUrls: [sourceUrl],
      });
      expect(parsed.success, sourceUrl).toBe(false);
      if (!parsed.success) {
        expect(JSON.stringify(parsed.error.issues)).not.toContain(sourceUrl);
      }
    }
  });

  it("accepts community replies only for one explicit X interaction", () => {
    expect(MarketingDraftRequestSchema.parse({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionUrl: "https://x.com/community/status/123456789",
    })).toEqual({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      sourceUrls: [],
      interactionUrl: "https://x.com/community/status/123456789",
    });

    expect(
      MarketingDraftRequestSchema.safeParse({
        kind: "community_reply",
        brief: "Answer this explicit OpenZaps mention.",
        channels: ["discord"],
        interactionUrl: "https://x.com/community/status/123456789",
      }).success,
    ).toBe(false);
  });

  it("rejects spoofable caller-supplied trigger/count metadata and non-canonical X URLs", () => {
    expect(
      MarketingDraftRequestSchema.safeParse({
        kind: "community_reply",
        brief: "Paraphrased question about bounded agent authority.",
        channels: ["x"],
        interactionUrl: "https://x.com/community/status/123456789",
        interaction: {
          id: "123456789",
          trigger: "mention",
          priorAutomatedReplyCount: 0,
        },
      }).success,
    ).toBe(false);

    for (const interactionUrl of [
      "http://x.com/community/status/123456789",
      "https://twitter.com/community/status/123456789",
      "https://x.com/community/status/123456789/",
      "https://x.com/community/status/123456789?trigger=mention",
      "https://x.com/community/status/12345678901234567890",
    ]) {
      expect(
        MarketingDraftRequestSchema.safeParse({
          kind: "community_reply",
          brief: "Paraphrased question about bounded agent authority.",
          channels: ["x"],
          interactionUrl,
        }).success,
        interactionUrl,
      ).toBe(false);
    }
  });

  it.each([
    `Use sk-proj-${"a".repeat(40)} for this update.`,
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "Webhook https://discord.com/api/webhooks/123/secret-token-value",
    "-----BEGIN PRIVATE KEY-----\nnot-for-a-model",
    "Use https://www.0xzaps.com/docs?token=redacted as the CTA.",
  ])("rejects credential-like brief data before model processing", (brief) => {
    const parsed = MarketingDraftRequestSchema.safeParse({
      kind: "product_update",
      brief,
      channels: ["x"],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const rendered = JSON.stringify(parsed.error.issues);
      expect(rendered).toContain("Remove it before model processing.");
      expect(rendered).not.toContain(brief);
    }
  });
});

describe("generated marketing output contracts", () => {
  const claim = {
    text: "OpenZaps uses bounded authority.",
    factKeys: ["authority.execution"],
    treatment: "asserted" as const,
  };

  it("enforces channel-specific lengths and Substack presentation fields", () => {
    expect(
      GeneratedChannelDraftSchema.safeParse({
        channel: "x",
        body: "x".repeat(281),
        links: [],
        claims: [claim],
        topics: ["protocol"],
        title: null,
        subtitle: null,
        tags: null,
      }).success,
    ).toBe(false);

    expect(
      GeneratedChannelDraftSchema.safeParse({
        channel: "discord",
        body: "d".repeat(2_001),
        links: [],
        claims: [claim],
        topics: ["protocol"],
        title: null,
        subtitle: null,
        tags: null,
      }).success,
    ).toBe(false);

    expect(
      GeneratedChannelDraftSchema.safeParse({
        channel: "substack",
        title: "A bounded OpenZaps tutorial",
        body: "Useful tutorial step. ".repeat(20),
        links: [],
        claims: [claim],
        topics: ["protocol"],
        subtitle: null,
        tags: ["OpenZaps", "DeFi"],
      }).success,
    ).toBe(true);
  });

  it("keeps model-facing links portable while validating URLs at runtime", () => {
    expect(
      GeneratedChannelDraftSchema.safeParse({
        channel: "x",
        body: "OpenZaps uses bounded authority.",
        links: ["not-an-absolute-url"],
        claims: [claim],
        topics: ["protocol"],
        title: null,
        subtitle: null,
        tags: null,
      }).success,
    ).toBe(false);

    const jsonSchema = JSON.stringify(
      z.toJSONSchema(GeneratedMarketingDraftSchema),
    );
    expect(jsonSchema).not.toContain('"format":"uri"');
    expect(jsonSchema).toContain(
      '"required":["channel","body","links","claims","topics","title","subtitle","tags"]',
    );
  });

  it.each([
    { body: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
    {
      body: "A safe body.",
      links: ["https://www.0xzaps.com/docs?token=redacted"],
    },
    {
      body: "Useful tutorial step. ".repeat(20),
      title:
        "Webhook https://discord.com/api/webhooks/123456789/example-secret-token",
    },
    {
      body: "Useful tutorial step. ".repeat(20),
      subtitle: "-----BEGIN PRIVATE KEY-----",
    },
    {
      body: "Useful tutorial step. ".repeat(20),
      tags: ["access_token=abcdefghijklmnopqrstuvwxyz"],
    },
  ])("rejects credential-like generated public fields: %j", (override) => {
    const generatedDraft = {
      channel:
        override.title || override.subtitle || override.tags
          ? "substack"
          : "x",
      links: [],
      claims: [claim],
      topics: ["protocol"],
      title:
        override.title || override.subtitle || override.tags
          ? "A bounded OpenZaps tutorial"
          : null,
      subtitle: null,
      tags:
        override.title || override.subtitle || override.tags
          ? ["OpenZaps", "DeFi"]
          : null,
    };
    const parsed = GeneratedChannelDraftSchema.safeParse({
      ...generatedDraft,
      ...override,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain(
        "credential-like data",
      );
    }
  });

  it("keeps approval records strict and bounded", () => {
    expect(
      MarketingApprovalPayloadSchema.safeParse({
        decision: "approve",
        approvedBy: "authenticated-operator",
      }).success,
    ).toBe(true);
    expect(
      MarketingApprovalPayloadSchema.safeParse({
        decision: "approve",
        approvedBy: "authenticated-operator",
        overridePolicy: true,
      }).success,
    ).toBe(false);
  });

  it("admits only channel/action pairs with a deployed adapter", () => {
    const sourcePacket = {
      id: "sources:test",
      createdAt: "2026-07-29T12:00:00.000Z",
      protocolPreAudit: true,
      facts: [],
      externalData: [],
      interaction: null,
    };
    const base = {
      id: "candidate:test",
      kind: "product_update" as const,
      topics: ["protocol" as const],
      body: "A reviewed update.",
      links: [],
      disclosures: [],
      claims: [],
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

    for (const [channel, action] of [
      ["x", "broadcast"],
      ["x", "reply"],
      ["discord", "broadcast"],
      ["substack", "prepare_tutorial"],
    ] as const) {
      expect(
        DeployedMarketingCandidateSchema.safeParse({
          ...base,
          channel,
          action,
        }).success,
      ).toBe(true);
    }

    for (const [channel, action] of [
      ["x", "direct_message"],
      ["discord", "reply"],
      ["discord", "direct_message"],
      ["substack", "publish_tutorial"],
    ] as const) {
      expect(
        DeployedMarketingCandidateSchema.safeParse({
          ...base,
          channel,
          action,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects credential-like data added to an assembled review bundle", () => {
    const observedAt = "2026-07-29T12:00:00.000Z";
    const sourcePacket = {
      id: "sources:test",
      createdAt: observedAt,
      protocolPreAudit: true,
      facts: [],
      externalData: [],
      interaction: null,
    };
    const candidate = {
      id: "candidate:substack",
      channel: "substack" as const,
      action: "prepare_tutorial" as const,
      kind: "tutorial" as const,
      topics: ["protocol" as const],
      body: "Useful tutorial step. ".repeat(20),
      links: ["https://www.0xzaps.com/docs"],
      disclosures: ["pre_audit" as const],
      claims: [],
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
    const parsed = MarketingDraftBundleSchema.safeParse({
      id: "draft:test",
      runId: "run:test",
      requestedAt: observedAt,
      model: "test-model",
      request: {
        kind: "tutorial",
        brief: "Explain bounded agent authority in a verified tutorial.",
        channels: ["substack"],
        sourceUrls: [],
      },
      sourcePacket,
      candidates: [candidate],
      presentations: [{
        candidateId: candidate.id,
        channel: "substack",
        title: "A source-backed OpenZaps tutorial",
        subtitle:
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        tags: ["OpenZaps"],
      }],
      policy: [{
        policyVersion: 2,
        candidateId: candidate.id,
        riskTier: 2,
        disposition: "require_approval",
        approvalRequired: true,
        approvalReasons: ["every_run_human_approval"],
        requiredDisclosures: ["pre_audit"],
        dailyCounter: "substackTutorials",
        issues: [],
        evaluatedAt: observedAt,
      }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain(
        "credential-like public data",
      );
    }
  });
});
