import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeployedMarketingCandidateSchema,
  GeneratedChannelDraftSchema,
  GeneratedMarketingDraftSchema,
  MarketingApprovalPayloadSchema,
  MarketingDraftBundleSchema,
  MarketingDraftApiRequestSchema,
  MarketingDraftRequestSchema,
  MarketingScheduledRequestSchema,
  type MarketingDraftBundle,
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

  it("binds Substack requests to one source-controlled tutorial selection", () => {
    expect(MarketingDraftRequestSchema.safeParse({
      kind: "tutorial",
      brief: "Prepare the reviewed source-controlled tutorial.",
      channels: ["substack"],
      tutorialId: "paper-trade-first-authority-map",
    }).success).toBe(true);
    expect(MarketingDraftRequestSchema.safeParse({
      kind: "tutorial",
      brief: "Prepare a tutorial without a source selection.",
      channels: ["substack"],
    }).success).toBe(false);
    expect(MarketingDraftRequestSchema.safeParse({
      kind: "product_update",
      brief: "Try to send generated copy to Substack.",
      channels: ["substack"],
      tutorialId: "paper-trade-first-authority-map",
    }).success).toBe(false);
    expect(MarketingDraftRequestSchema.safeParse({
      kind: "tutorial",
      brief: "Attach a tutorial selection to the wrong channel.",
      channels: ["x"],
      tutorialId: "paper-trade-first-authority-map",
    }).success).toBe(false);
  });

  it("binds scheduled workflow input to one reviewed campaign/channel pair", () => {
    expect(
      MarketingScheduledRequestSchema.parse({
        campaignId: "virtual-trading-request-zap-v2",
        channel: "discord",
        slotDay: "2026-07-31",
        contentHash: "ab".repeat(32),
      }),
    ).toEqual({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-31",
      contentHash: "ab".repeat(32),
    });
    expect(
      MarketingScheduledRequestSchema.safeParse({
        campaignId: "virtual-trading-request-zap-v2",
        channel: "substack",
        slotDay: "2026-07-31",
        contentHash: "ab".repeat(32),
      }).success,
    ).toBe(false);
    expect(
      MarketingScheduledRequestSchema.safeParse({
        campaignId: "../caller-selected",
        channel: "discord",
        slotDay: "2026-07-31",
        contentHash: "ab".repeat(32),
      }).success,
    ).toBe(false);
    expect(
      MarketingScheduledRequestSchema.safeParse({
        channels: ["discord"],
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

  it("binds exact channel attribution links to requested channels and sources", () => {
    const sourceUrl = "https://www.0xzaps.com/virtual-trading";
    const xUrl = `${sourceUrl}?utm_source=x&utm_medium=social&utm_campaign=virtual-trading&utm_content=feed_update`;
    const discordUrl = `${sourceUrl}?utm_source=discord&utm_medium=community&utm_campaign=virtual-trading&utm_content=feed_update`;

    expect(MarketingDraftRequestSchema.parse({
      kind: "product_update",
      brief: "Syndicate one approved OpenZaps product update.",
      channels: ["x", "discord"],
      sourceUrls: [sourceUrl],
      requiredChannelLinks: { x: xUrl, discord: discordUrl },
    })).toMatchObject({
      requiredChannelLinks: { x: xUrl, discord: discordUrl },
    });

    for (const request of [
      {
        kind: "product_update",
        brief: "Syndicate one approved OpenZaps product update.",
        channels: ["discord"],
        sourceUrls: [sourceUrl],
        requiredChannelLinks: { x: xUrl },
      },
      {
        kind: "product_update",
        brief: "Syndicate one approved OpenZaps product update.",
        channels: ["x"],
        sourceUrls: [sourceUrl],
        requiredChannelLinks: {
          x: "https://www.0xzaps.com/docs?utm_source=x",
        },
      },
      {
        kind: "community_reply",
        brief: "Answer a verified question about bounded authority.",
        channels: ["x"],
        interactionUrl: "https://x.com/community/status/123456789",
        sourceUrls: [sourceUrl],
        requiredChannelLinks: { x: xUrl },
      },
    ]) {
      expect(MarketingDraftApiRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("accepts community replies only for one explicit X interaction", () => {
    expect(MarketingDraftApiRequestSchema.parse({
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

    expect(MarketingDraftRequestSchema.parse({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionReference: "8".repeat(30),
    })).toMatchObject({
      interactionReference: "8".repeat(30),
    });

    expect(
      MarketingDraftApiRequestSchema.safeParse({
        kind: "community_reply",
        brief: "Answer this explicit OpenZaps mention.",
        channels: ["discord"],
        interactionUrl: "https://x.com/community/status/123456789",
      }).success,
    ).toBe(false);
  });

  it("rejects spoofable caller-supplied trigger/count metadata and non-canonical X URLs", () => {
    expect(
      MarketingDraftApiRequestSchema.safeParse({
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
        MarketingDraftApiRequestSchema.safeParse({
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

  function validReviewBundle(): MarketingDraftBundle {
    const observedAt = "2026-07-29T12:00:00.000Z";
    const sourcePacket = {
      id: "sources:bundle-invariants",
      createdAt: observedAt,
      protocolPreAudit: true,
      facts: [],
      externalData: [],
      interaction: null,
    };
    const body = "Useful tutorial step. ".repeat(20);
    const title = "A source-backed OpenZaps tutorial";
    const tags = ["OpenZaps", "DeFi"];
    const sourceSha256 = "a".repeat(64);
    const bodySha256 = "b".repeat(64);
    const candidate = {
      id: "candidate:substack",
      channel: "substack" as const,
      action: "prepare_tutorial" as const,
      kind: "tutorial" as const,
      topics: ["protocol" as const],
      body,
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
    return {
      id: "draft:bundle-invariants",
      runId: "run:bundle-invariants",
      requestedAt: observedAt,
      model: "test-model",
      request: {
        kind: "tutorial" as const,
        brief: "Explain bounded agent authority in a verified tutorial.",
        channels: ["substack" as const],
        sourceUrls: [],
        tutorialId: "paper-trade-first-authority-map",
      },
      sourcePacket,
      tutorialHandoff: {
        version: 1 as const,
        channel: "substack" as const,
        status: "requires_owner_approval" as const,
        tutorialId: "paper-trade-first-authority-map",
        manifestStatus: "draft" as const,
        sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
        sourceSha256,
        bodySha256,
        title,
        tags,
        topics: ["protocol" as const],
        disclosures: ["pre_audit" as const],
        claims: [],
        links: ["https://www.0xzaps.com/docs"],
        bodyMarkdown: body,
        editorUrl: "https://defitutorials.substack.com/publish/post" as const,
        publicationUrl: "https://defitutorials.substack.com" as const,
        modelRewriteAllowed: false as const,
        apiWriteAttempted: false as const,
        privateEndpointUsed: false as const,
        approval: {
          required: true as const,
          decision: "pending" as const,
          scope: "exact_source_and_body_sha256" as const,
          tutorialId: "paper-trade-first-authority-map",
          sourceSha256,
          bodySha256,
          statement:
            "Approve only these exact source and editor-body hashes for a human-only DeFi Tutorials handoff." as const,
        },
      },
      candidates: [candidate],
      presentations: [{
        candidateId: candidate.id,
        channel: "substack" as const,
        title,
        tags,
      }],
      policy: [{
        policyVersion: 2 as const,
        candidateId: candidate.id,
        riskTier: 2 as const,
        disposition: "require_approval" as const,
        approvalRequired: true,
        approvalReasons: ["every_run_human_approval", "tutorial"],
        requiredDisclosures: ["pre_audit" as const],
        dailyCounter: "substackTutorials" as const,
        issues: [],
        evaluatedAt: observedAt,
      }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };
  }

  function validRequiredLinkBundle(): MarketingDraftBundle {
    const bundle = validReviewBundle();
    const sourceUrl = "https://www.0xzaps.com/virtual-trading";
    const requiredUrl =
      `${sourceUrl}?utm_source=x&utm_medium=social&utm_campaign=virtual-trading&utm_content=feed_update`;
    bundle.request = {
      kind: "product_update",
      brief: "Syndicate one approved OpenZaps product update.",
      channels: ["x"],
      sourceUrls: [sourceUrl],
      requiredChannelLinks: { x: requiredUrl },
    };
    delete bundle.tutorialHandoff;
    bundle.candidates[0] = {
      ...bundle.candidates[0],
      id: "candidate:x",
      channel: "x",
      action: "broadcast",
      kind: "product_update",
      body: `Paper-trade a deployed route with read-only quotes. ${requiredUrl}`,
      links: [requiredUrl],
    };
    bundle.presentations[0] = {
      candidateId: "candidate:x",
      channel: "x",
    };
    bundle.policy[0] = {
      ...bundle.policy[0],
      candidateId: "candidate:x",
      dailyCounter: "xPosts",
    };
    return bundle;
  }

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

    expect(
      GeneratedChannelDraftSchema.safeParse({
        channel: "substack",
        title: "A bounded OpenZaps tutorial",
        body: "Useful tutorial step. ".repeat(20),
        links: [],
        claims: [claim],
        topics: ["protocol"],
        subtitle: null,
        tags: ["OpenZaps", "openzaps"],
      }).success,
    ).toBe(false);
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
        tutorialApproval: {
          decision: "approve",
          approvedBy: "authenticated-operator",
          tutorialId: "paper-trade-first-authority-map",
          sourceSha256: "a".repeat(64),
          bodySha256: "b".repeat(64),
        },
      }).success,
    ).toBe(true);
    expect(
      MarketingApprovalPayloadSchema.safeParse({
        decision: "reject",
        approvedBy: "authenticated-operator",
        tutorialApproval: {
          decision: "approve",
          approvedBy: "authenticated-operator",
          tutorialId: "paper-trade-first-authority-map",
          sourceSha256: "a".repeat(64),
          bodySha256: "b".repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      MarketingApprovalPayloadSchema.safeParse({
        decision: "approve",
        approvedBy: "authenticated-operator",
        overridePolicy: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a one-to-one candidate, presentation, and policy bundle", () => {
    expect(MarketingDraftBundleSchema.safeParse(validReviewBundle()).success)
      .toBe(true);
  });

  it("re-enforces exact required channel links on the final reviewed bundle", () => {
    expect(
      MarketingDraftBundleSchema.safeParse(validRequiredLinkBundle()).success,
    ).toBe(true);

    const missingLinkMetadata = validRequiredLinkBundle();
    missingLinkMetadata.candidates[0].links = [];
    expect(
      MarketingDraftBundleSchema.safeParse(missingLinkMetadata).success,
    ).toBe(false);

    const substringOnlyBody = validRequiredLinkBundle();
    substringOnlyBody.candidates[0].body =
      `${substringOnlyBody.request.requiredChannelLinks?.x}&unexpected=1`;
    expect(
      MarketingDraftBundleSchema.safeParse(substringOnlyBody).success,
    ).toBe(false);
  });

  it.each([
    [
      "duplicate candidate id/channel",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.candidates.push(structuredClone(input.candidates[0]));
        input.presentations.push(structuredClone(input.presentations[0]));
        input.policy.push(structuredClone(input.policy[0]));
      },
    ],
    [
      "missing presentation",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.presentations = [];
      },
    ],
    [
      "duplicate presentation",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.presentations.push(structuredClone(input.presentations[0]));
      },
    ],
    [
      "presentation for another candidate",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.presentations[0].candidateId = "candidate:other";
      },
    ],
    [
      "missing policy decision",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.policy = [];
      },
    ],
    [
      "duplicate policy decision",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.policy.push(structuredClone(input.policy[0]));
      },
    ],
    [
      "policy decision for another candidate",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.policy[0].candidateId = "candidate:other";
      },
    ],
    [
      "unrequested candidate channel",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.request.channels = ["x"];
      },
    ],
    [
      "candidate kind different from request",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.request.kind = "educational";
      },
    ],
    [
      "candidate evidence different from bundle evidence",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.candidates[0].sourcePacket = {
          ...input.sourcePacket,
          id: "sources:other",
        };
      },
    ],
    [
      "candidate/presentation channel mismatch",
      (input: ReturnType<typeof validReviewBundle>) => {
        input.presentations[0].channel = "x";
      },
    ],
  ])("rejects a bundle with %s", (_label, mutate) => {
    const input = validReviewBundle();
    mutate(input);
    expect(MarketingDraftBundleSchema.safeParse(input).success).toBe(false);
  });

  it("requires exact Substack presentation metadata and forbids it elsewhere", () => {
    const missingTags = validReviewBundle();
    delete missingTags.presentations[0].tags;
    expect(MarketingDraftBundleSchema.safeParse(missingTags).success).toBe(
      false,
    );

    const duplicateTags = validReviewBundle();
    duplicateTags.presentations[0].tags = ["OpenZaps", "openzaps"];
    expect(MarketingDraftBundleSchema.safeParse(duplicateTags).success).toBe(
      false,
    );

    const shortTutorial = validReviewBundle();
    shortTutorial.candidates[0].body = "Too short for an editor handoff.";
    expect(MarketingDraftBundleSchema.safeParse(shortTutorial).success).toBe(
      false,
    );

    const nonSubstack = validReviewBundle();
    delete nonSubstack.tutorialHandoff;
    nonSubstack.request = {
      ...nonSubstack.request,
      kind: "educational",
      channels: ["x"],
    };
    delete nonSubstack.request.tutorialId;
    nonSubstack.candidates[0] = {
      ...nonSubstack.candidates[0],
      channel: "x",
      action: "broadcast",
      kind: "educational",
    };
    nonSubstack.presentations[0].channel = "x";
    expect(MarketingDraftBundleSchema.safeParse(nonSubstack).success).toBe(
      false,
    );
  });

  it("binds the reply action to the exact requested and verified X interaction", () => {
    const unexpectedReply = validReviewBundle();
    unexpectedReply.request.channels = ["x"];
    unexpectedReply.candidates[0] = {
      ...unexpectedReply.candidates[0],
      channel: "x",
      action: "reply",
    };
    unexpectedReply.presentations[0] = {
      candidateId: unexpectedReply.candidates[0].id,
      channel: "x",
    };
    unexpectedReply.policy[0].dailyCounter = "xReplies";
    expect(
      MarketingDraftBundleSchema.safeParse(unexpectedReply).success,
    ).toBe(false);

    const wrongTarget = validReviewBundle();
    const interaction = {
      id: "9".repeat(30),
      trigger: "mention" as const,
      observedAt: wrongTarget.requestedAt,
    };
    wrongTarget.request = {
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      sourceUrls: [],
      interactionReference: "8".repeat(30),
    };
    wrongTarget.sourcePacket = {
      ...wrongTarget.sourcePacket,
      interaction,
    };
    wrongTarget.candidates[0] = {
      ...wrongTarget.candidates[0],
      channel: "x",
      action: "reply",
      kind: "community_reply",
      sourcePacket: wrongTarget.sourcePacket,
      interaction,
    };
    wrongTarget.presentations[0] = {
      candidateId: wrongTarget.candidates[0].id,
      channel: "x",
    };
    wrongTarget.policy[0].dailyCounter = "xReplies";

    expect(MarketingDraftBundleSchema.safeParse(wrongTarget).success).toBe(
      false,
    );
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
          body:
            channel === "substack"
              ? "A reviewed tutorial step. ".repeat(20)
              : base.body,
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
