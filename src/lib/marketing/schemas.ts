import { z } from "zod";

import {
  MARKETING_ACTIONS,
  MARKETING_CHANNELS,
  MARKETING_CONTENT_KINDS,
  MARKETING_DISCLOSURES,
  MARKETING_FACT_STATUSES,
  MARKETING_POLICY_VERSION,
  MARKETING_RISK_TIERS,
  MARKETING_RUN_STATES,
  MARKETING_TOPICS,
} from "@/lib/marketing/types";

export const MarketingRunStateSchema = z.enum(MARKETING_RUN_STATES);
export const MarketingRiskTierSchema = z.union(MARKETING_RISK_TIERS.map((tier) => z.literal(tier)));
export const MarketingChannelSchema = z.enum(MARKETING_CHANNELS);
export const MarketingActionSchema = z.enum(MARKETING_ACTIONS);
export const MarketingContentKindSchema = z.enum(MARKETING_CONTENT_KINDS);
export const MarketingTopicSchema = z.enum(MARKETING_TOPICS);
export const MarketingDisclosureSchema = z.enum(MARKETING_DISCLOSURES);

export const MarketingFactSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    status: z.enum(MARKETING_FACT_STATUSES),
    sourceUrl: z.string().url(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.status === "unavailable" && fact.value !== null) {
      context.addIssue({
        code: "custom",
        message: "Unavailable facts must use null, never a numeric or textual stand-in.",
        path: ["value"],
      });
    }
  });

export const MarketingExternalDataSchema = z
  .object({
    id: z.string().min(1),
    sourceUrl: z.string().url(),
    observedAt: z.iso.datetime(),
    content: z.string(),
    instructionsTrusted: z.literal(false),
    handling: z.literal("data_only"),
  })
  .strict();

export const MarketingInteractionSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d{29}$/u),
    trigger: z.enum(["mention", "quote"]),
    observedAt: z.iso.datetime(),
  })
  .strict();

export const MarketingSourcePacketSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.iso.datetime(),
    protocolPreAudit: z.boolean(),
    facts: z.array(MarketingFactSchema),
    externalData: z.array(MarketingExternalDataSchema),
    interaction: MarketingInteractionSchema.nullable(),
  })
  .strict()
  .superRefine((packet, context) => {
    const keys = new Set<string>();
    packet.facts.forEach((fact, index) => {
      if (keys.has(fact.key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate fact key: ${fact.key}`,
          path: ["facts", index, "key"],
        });
      }
      keys.add(fact.key);
    });
  });

export const MarketingClaimSchema = z
  .object({
    text: z.string().min(1),
    factKeys: z.array(z.string().min(1)),
    treatment: z.enum(["asserted", "qualified", "omitted"]),
  })
  .strict();

export const MarketingPolicyFlagsSchema = z
  .object({
    containsCredential: z.boolean(),
    guaranteesReturns: z.boolean(),
    impersonatesPerson: z.boolean(),
    requestsPolicyBypass: z.boolean(),
    unsolicitedBulkMessaging: z.boolean(),
    usesUnavailableAsZero: z.boolean(),
  })
  .strict();

export const MarketingCandidateSchema = z
  .object({
    id: z.string().min(1),
    channel: MarketingChannelSchema,
    action: MarketingActionSchema,
    kind: MarketingContentKindSchema,
    topics: z.array(MarketingTopicSchema),
    body: z.string().min(1),
    links: z.array(z.string().min(1)),
    disclosures: z.array(MarketingDisclosureSchema),
    claims: z.array(MarketingClaimSchema),
    sourcePacket: MarketingSourcePacketSchema,
    interaction: MarketingInteractionSchema.nullable(),
    flags: MarketingPolicyFlagsSchema,
  })
  .strict();

export const MarketingDailyCountersSchema = z
  .object({
    xPosts: z.number().int().nonnegative(),
    xReplies: z.number().int().nonnegative(),
    discordPosts: z.number().int().nonnegative(),
    substackTutorials: z.number().int().nonnegative(),
    directMessages: z.number().int().nonnegative(),
  })
  .strict();

export const MarketingConfigSchema = z
  .object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    autoPublishRequested: z.boolean(),
    autoPublish: z.boolean(),
    xAiReplyApproved: z.boolean(),
    xAutomatedLabelConfirmed: z.boolean(),
    mode: z.enum(["disabled", "dry_run", "review_only", "live"]),
    dailyCaps: MarketingDailyCountersSchema,
    readiness: z
      .object({
        configurationValid: z.boolean(),
        canDraft: z.boolean(),
        durableLedgerConfigured: z.boolean(),
        autoPublishReady: z.boolean(),
        channels: z
          .object({
            x: z.boolean(),
            discordBroadcast: z.boolean(),
            discordInteractions: z.boolean(),
            directMessages: z.literal(false),
            substackDirectPublish: z.literal(false),
            substackManualHandoff: z.literal(true),
            farcaster: z.literal(false),
            github: z.literal(false),
          })
          .strict(),
        blockers: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const scheduledChannelReady =
      config.readiness.channels.x ||
      config.readiness.channels.discordBroadcast;
    const prerequisitesReady =
      config.enabled &&
      !config.dryRun &&
      config.readiness.configurationValid &&
      config.readiness.canDraft &&
      config.readiness.durableLedgerConfigured &&
      scheduledChannelReady;
    if (
      config.readiness.autoPublishReady !== prerequisitesReady ||
      config.autoPublish !==
        (config.autoPublishRequested && config.readiness.autoPublishReady) ||
      (config.autoPublish && config.mode !== "live") ||
      (!config.autoPublish && config.mode === "live")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Auto-publish state must exactly match its bounded scheduled-template prerequisites.",
      });
    }
  });

export const MarketingPolicyContextSchema = z
  .object({
    now: z.iso.datetime(),
    config: MarketingConfigSchema,
    usage: z
      .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        counts: MarketingDailyCountersSchema,
      })
      .strict(),
    humanApproved: z.boolean(),
    automaticAuthorization: z
      .object({
        kind: z.literal("scheduled_template"),
        templateId: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[a-z0-9][a-z0-9-]*$/u),
      })
      .strict()
      .optional(),
    repliedInteractionIds: z.array(z.string()),
  })
  .strict();

export const MarketingPolicyIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const MarketingPolicyDecisionSchema = z
  .object({
    policyVersion: z.literal(MARKETING_POLICY_VERSION),
    candidateId: z.string().min(1),
    riskTier: MarketingRiskTierSchema,
    disposition: z.enum(["allow", "require_approval", "dry_run", "blocked", "prohibited"]),
    approvalRequired: z.boolean(),
    approvalReasons: z.array(z.string()),
    requiredDisclosures: z.array(MarketingDisclosureSchema),
    dailyCounter: z
      .enum(["xPosts", "xReplies", "discordPosts", "substackTutorials", "directMessages"])
      .nullable(),
    issues: z.array(MarketingPolicyIssueSchema),
    evaluatedAt: z.iso.datetime(),
  })
  .strict();
