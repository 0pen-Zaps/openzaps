import { z } from "zod";

import {
  MarketingCandidateSchema,
  MarketingClaimSchema,
  MarketingPolicyDecisionSchema,
  MarketingSourcePacketSchema,
  MarketingTopicSchema,
} from "@/lib/marketing";
import {
  containsCredentialLikeData,
  normalizeMarketingSourceUrl,
} from "@/lib/marketing/source-url";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";

export const DEPLOYED_MARKETING_CHANNELS = ["x", "discord", "substack"] as const;
export const DEPLOYED_MARKETING_KINDS = [
  "product_update",
  "tutorial",
  "educational",
  "community_reply",
] as const;

const canonicalSourceUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((raw, context) => {
    try {
      return normalizeMarketingSourceUrl(raw);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Source URL must be a public canonical OpenZaps or DeFi Tutorials URL without credentials.",
      });
      return z.NEVER;
    }
  });

const canonicalXInteractionUrl = z
  .string()
  .min(1)
  .max(128)
  .transform((raw, context) => {
    try {
      return parseCanonicalXStatusUrl(raw).url;
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "X target must be https://x.com/<user>/status/<1-19 digit id>.",
      });
      return z.NEVER;
    }
  });

export const MarketingDraftRequestSchema = z
  .object({
    kind: z.enum(DEPLOYED_MARKETING_KINDS),
    brief: z.string().trim().min(8).max(4_000),
    channels: z.array(z.enum(DEPLOYED_MARKETING_CHANNELS)).min(1).max(3),
    sourceUrls: z.array(canonicalSourceUrl).max(5).default([]),
    interactionUrl: canonicalXInteractionUrl.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.channels).size !== request.channels.length) {
      context.addIssue({ code: "custom", message: "Channels must be unique.", path: ["channels"] });
    }
    if (request.kind === "community_reply") {
      if (!request.interactionUrl) {
        context.addIssue({
          code: "custom",
          message: "A canonical X target URL is required for a community reply.",
          path: ["interactionUrl"],
        });
      }
      if (request.channels.length !== 1 || request.channels[0] !== "x") {
        context.addIssue({
          code: "custom",
          message: "Community replies are currently supported only on X.",
          path: ["channels"],
        });
      }
    } else if (request.interactionUrl) {
      context.addIssue({
        code: "custom",
        message: "Interaction context is valid only for a community reply.",
        path: ["interactionUrl"],
      });
    }
    if (containsCredentialLikeData(request.brief)) {
      context.addIssue({
        code: "custom",
        message:
          "The brief appears to contain a credential. Remove it before model processing.",
        path: ["brief"],
      });
    }
  });

export type MarketingDraftRequest = z.infer<typeof MarketingDraftRequestSchema>;

// Keep the model-facing JSON Schema provider-portable: OpenAI rejects the
// `format: "uri"` keyword emitted by z.url(). Runtime validation still
// requires an absolute URL, and policy separately restricts outbound hosts.
const generatedLink = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (raw) => {
      try {
        new URL(raw);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Link must be an absolute URL." },
  );

export const GeneratedChannelDraftSchema = z
  .object({
    channel: z.enum(DEPLOYED_MARKETING_CHANNELS),
    body: z.string().min(1).max(100_000),
    links: z.array(generatedLink).max(8),
    claims: z.array(MarketingClaimSchema).max(24),
    topics: z.array(MarketingTopicSchema).max(8),
    title: z.string().trim().min(1).max(200).nullable(),
    subtitle: z.string().trim().min(1).max(300).nullable(),
    tags: z
      .array(z.string().trim().min(1).max(32))
      .min(2)
      .max(5)
      .nullable(),
  })
  .strict()
  .superRefine((draft, context) => {
    const length = Array.from(draft.body).length;
    const publicFields = [
      draft.body,
      ...draft.links,
      draft.title ?? "",
      draft.subtitle ?? "",
      ...(draft.tags ?? []),
    ].join("\n");
    if (containsCredentialLikeData(publicFields)) {
      context.addIssue({
        code: "custom",
        message: "Generated public content contains credential-like data.",
      });
    }
    if (draft.channel === "x" && length > 280) {
      context.addIssue({ code: "custom", message: "X copy exceeds 280 characters.", path: ["body"] });
    }
    if (draft.channel === "discord" && length > 2_000) {
      context.addIssue({ code: "custom", message: "Discord copy exceeds 2,000 characters.", path: ["body"] });
    }
    if (
      draft.channel === "substack" &&
      (!draft.title || !draft.tags || length < 300)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Substack tutorials need a title, 2-5 tags, and at least 300 characters of body copy.",
        path: ["body"],
      });
    }
    if (draft.channel !== "substack" && (draft.title || draft.subtitle || draft.tags)) {
      context.addIssue({
        code: "custom",
        message: "Title, subtitle, and tags are reserved for Substack drafts.",
      });
    }
  });

export const GeneratedMarketingDraftSchema = z
  .object({
    items: z.array(GeneratedChannelDraftSchema).min(1).max(3),
  })
  .strict();

export type GeneratedChannelDraft = z.infer<typeof GeneratedChannelDraftSchema>;

export const DeployedMarketingCandidateSchema = MarketingCandidateSchema.extend({
  channel: z.enum(DEPLOYED_MARKETING_CHANNELS),
})
  .strict()
  .superRefine((candidate, context) => {
    const supported =
      (candidate.channel === "x"
        && (candidate.action === "broadcast" || candidate.action === "reply"))
      || (candidate.channel === "discord" && candidate.action === "broadcast")
      || (candidate.channel === "substack"
        && candidate.action === "prepare_tutorial");
    if (!supported) {
      context.addIssue({
        code: "custom",
        message:
          "This channel/action pair has no deployed marketing adapter.",
        path: ["action"],
      });
    }
  });

export type DeployedMarketingCandidate = z.infer<typeof DeployedMarketingCandidateSchema>;

export const MarketingDraftBundleSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    requestedAt: z.iso.datetime(),
    model: z.string().min(1),
    request: MarketingDraftRequestSchema,
    sourcePacket: MarketingSourcePacketSchema,
    candidates: z.array(DeployedMarketingCandidateSchema).min(1).max(3),
    presentations: z
      .array(
        z
          .object({
            candidateId: z.string().min(1),
            channel: z.enum(DEPLOYED_MARKETING_CHANNELS),
            title: z.string().trim().min(1).max(200).optional(),
            subtitle: z.string().trim().min(1).max(300).optional(),
            tags: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    policy: z.array(MarketingPolicyDecisionSchema).min(1).max(3),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        totalTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const publicFields = [
      ...bundle.candidates.flatMap((candidate) => [
        candidate.body,
        ...candidate.links,
      ]),
      ...bundle.presentations.flatMap((presentation) => [
        presentation.title ?? "",
        presentation.subtitle ?? "",
        ...(presentation.tags ?? []),
      ]),
    ].join("\n");
    if (containsCredentialLikeData(publicFields)) {
      context.addIssue({
        code: "custom",
        message:
          "The reviewed marketing bundle contains credential-like public data.",
      });
    }
  });

export type MarketingDraftBundle = z.infer<typeof MarketingDraftBundleSchema>;

export const MarketingApprovalPayloadSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    approvedBy: z.string().trim().min(1).max(120),
    comment: z.string().trim().max(1_000).optional(),
  })
  .strict();

export type MarketingApprovalPayload = z.infer<typeof MarketingApprovalPayloadSchema>;

export const MarketingDeliverySchema = z
  .object({
    channel: z.enum(DEPLOYED_MARKETING_CHANNELS),
    candidateId: z.string().min(1),
    status: z.enum(["published", "requires_human_publish", "dry_run", "failed", "blocked"]),
    idempotencyKey: z.string().min(1),
    providerMessageId: z.string().optional(),
    providerUrl: z.string().url().optional(),
    editorUrl: z.string().url().optional(),
    error: z.string().max(500).optional(),
  })
  .strict();

export type MarketingDelivery = z.infer<typeof MarketingDeliverySchema>;

export const MarketingWorkflowResultSchema = z
  .object({
    runId: z.string().min(1),
    status: z.enum([
      "published",
      "partially_published",
      "requires_human_publish",
      "completed_with_errors",
      "rejected",
      "blocked",
      "failed",
      "dry_run_complete",
    ]),
    draft: MarketingDraftBundleSchema,
    approval: MarketingApprovalPayloadSchema.nullable(),
    deliveries: z.array(MarketingDeliverySchema),
  })
  .strict();

export type MarketingWorkflowResult = z.infer<typeof MarketingWorkflowResultSchema>;

export const MarketingRunEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("draft"),
      at: z.iso.datetime(),
      state: z.enum(["awaiting_approval", "blocked", "dry_run_complete"]),
      draft: MarketingDraftBundleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval"),
      at: z.iso.datetime(),
      state: z.enum(["approved", "rejected"]),
      approval: MarketingApprovalPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      at: z.iso.datetime(),
      result: MarketingWorkflowResultSchema,
    })
    .strict(),
]);

export type MarketingRunEvent = z.infer<typeof MarketingRunEventSchema>;
