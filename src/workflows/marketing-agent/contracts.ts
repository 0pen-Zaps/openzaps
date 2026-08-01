import { z } from "zod";

import {
  MarketingCandidateSchema,
  MarketingClaimSchema,
  MarketingPolicyDecisionSchema,
  MarketingSourcePacketSchema,
  MarketingTopicSchema,
  SCHEDULED_MARKETING_CHANNELS,
} from "@/lib/marketing";
import {
  containsCredentialLikeData,
  normalizeMarketingSourceUrl,
} from "@/lib/marketing/source-url";
import {
  SourceControlledTutorialApprovalBundleSchema,
  SourceControlledTutorialApprovalReceiptSchema,
} from "@/lib/marketing/tutorial-handoff-contract";
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

const opaqueXInteractionReference = z
  .string()
  .regex(/^[1-9]\d{29}$/u);

const sourceControlledTutorialId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const marketingDraftRequestBase = z
  .object({
    kind: z.enum(DEPLOYED_MARKETING_KINDS),
    brief: z.string().trim().min(8).max(4_000),
    channels: z.array(z.enum(DEPLOYED_MARKETING_CHANNELS)).min(1).max(3),
    sourceUrls: z.array(canonicalSourceUrl).max(5).default([]),
    requiredChannelLinks: z
      .object({
        x: canonicalSourceUrl.optional(),
        discord: canonicalSourceUrl.optional(),
      })
      .strict()
      .optional(),
    tutorialId: sourceControlledTutorialId.optional(),
  })
  .strict();

type DraftRequestForRefinement = z.infer<typeof marketingDraftRequestBase> & {
  interactionUrl?: string;
  interactionReference?: string;
};

function refineMarketingDraftRequest(
  request: DraftRequestForRefinement,
  context: z.RefinementCtx,
  interactionKey: "interactionUrl" | "interactionReference",
): void {
  const interaction = request[interactionKey];
  const requestsSubstack = request.channels.includes("substack");
  if (new Set(request.channels).size !== request.channels.length) {
    context.addIssue({
      code: "custom",
      message: "Channels must be unique.",
      path: ["channels"],
    });
  }
  if (request.kind === "community_reply") {
    if (!interaction) {
      context.addIssue({
        code: "custom",
        message:
          interactionKey === "interactionUrl"
            ? "A canonical X target URL is required for a community reply."
            : "An opaque X interaction reference is required for a community reply.",
        path: [interactionKey],
      });
    }
    if (request.channels.length !== 1 || request.channels[0] !== "x") {
      context.addIssue({
        code: "custom",
        message: "Community replies are currently supported only on X.",
        path: ["channels"],
      });
    }
  } else if (interaction) {
    context.addIssue({
      code: "custom",
      message: "Interaction context is valid only for a community reply.",
      path: [interactionKey],
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
  if (
    request.kind === "community_reply"
    && /https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,19}/iu.test(
      request.brief,
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Keep the raw X target URL out of the paraphrased brief; the route stores it only in the short-lived subject vault.",
      path: ["brief"],
    });
  }
  if (request.requiredChannelLinks) {
    const entries = Object.entries(request.requiredChannelLinks);
    if (entries.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Required channel links cannot be empty.",
        path: ["requiredChannelLinks"],
      });
    }
    if (request.kind === "community_reply") {
      context.addIssue({
        code: "custom",
        message: "Community replies cannot require promotional links.",
        path: ["requiredChannelLinks"],
      });
    }
    const sourceDestinations = new Set(
      request.sourceUrls.map((raw) => {
        const url = new URL(raw);
        url.search = "";
        url.hash = "";
        return url.toString();
      }),
    );
    for (const [channel, raw] of entries) {
      if (!request.channels.includes(channel as "x" | "discord")) {
        context.addIssue({
          code: "custom",
          message: "A required link must target a requested channel.",
          path: ["requiredChannelLinks", channel],
        });
      }
      const url = new URL(raw);
      url.search = "";
      url.hash = "";
      if (!sourceDestinations.has(url.toString())) {
        context.addIssue({
          code: "custom",
          message: "A required link must attribute one of the canonical sources.",
          path: ["requiredChannelLinks", channel],
        });
      }
    }
  }
  if (requestsSubstack) {
    if (request.kind !== "tutorial") {
      context.addIssue({
        code: "custom",
        message:
          "Substack delivery is limited to source-controlled tutorial requests.",
        path: ["kind"],
      });
    }
    if (!request.tutorialId) {
      context.addIssue({
        code: "custom",
        message:
          "A source-controlled tutorial selection is required for Substack.",
        path: ["tutorialId"],
      });
    }
  } else if (request.tutorialId) {
    context.addIssue({
      code: "custom",
      message: "A tutorial selection is valid only when Substack is requested.",
      path: ["tutorialId"],
    });
  }
}

/**
 * Public operator input. The raw X URL is verified and vaulted in the route;
 * it must never be passed to Workflow.
 */
export const MarketingDraftApiRequestSchema = marketingDraftRequestBase
  .extend({ interactionUrl: canonicalXInteractionUrl.optional() })
  .strict()
  .superRefine((request, context) =>
    refineMarketingDraftRequest(request, context, "interactionUrl"));

/** Durable Workflow input. It contains only a random opaque subject reference. */
export const MarketingDraftRequestSchema = marketingDraftRequestBase
  .extend({ interactionReference: opaqueXInteractionReference.optional() })
  .strict()
  .superRefine((request, context) =>
    refineMarketingDraftRequest(request, context, "interactionReference"));

export type MarketingDraftRequest = z.infer<typeof MarketingDraftRequestSchema>;
export type MarketingDraftApiRequest = z.infer<
  typeof MarketingDraftApiRequestSchema
>;

export const MarketingScheduledRequestSchema = z
  .object({
    campaignId: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    channel: z.enum(SCHEDULED_MARKETING_CHANNELS),
    slotDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .refine((day) => {
        const parsed = new Date(`${day}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === day;
      }),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type MarketingScheduledRequest = z.infer<
  typeof MarketingScheduledRequestSchema
>;

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
    if (
      draft.tags &&
      new Set(draft.tags.map((tag) => tag.toLowerCase())).size !==
        draft.tags.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Substack tags must be unique.",
        path: ["tags"],
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
    const bodyLength = Array.from(candidate.body).length;
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
    if (
      (candidate.channel === "x" && bodyLength > 280) ||
      (candidate.channel === "discord" && bodyLength > 2_000) ||
      (candidate.channel === "substack" && bodyLength < 300)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Reviewed copy must satisfy the deployed channel length boundary.",
        path: ["body"],
      });
    }
  });

export type DeployedMarketingCandidate = z.infer<typeof DeployedMarketingCandidateSchema>;

export function marketingBodyContainsExactUrl(
  body: string,
  requiredUrl: string,
): boolean {
  const candidates = body.match(/https:\/\/[^\s<>"']+/gu) ?? [];
  return candidates.some(
    (candidate) => candidate.replace(/[\])}>.,!?;:]+$/gu, "") === requiredUrl,
  );
}

export function reviewMarketingDeliveryIdempotencyKey(
  bundleId: string,
  channel: (typeof DEPLOYED_MARKETING_CHANNELS)[number],
): string {
  return `${bundleId.replace(/[^A-Za-z0-9._:-]/gu, "_")}:${channel}`;
}

export const MarketingDraftBundleSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    requestedAt: z.iso.datetime(),
    model: z.string().min(1),
    request: MarketingDraftRequestSchema,
    scheduledClaim: MarketingScheduledRequestSchema.optional(),
    sourcePacket: MarketingSourcePacketSchema,
    tutorialHandoff: SourceControlledTutorialApprovalBundleSchema.optional(),
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
    const candidateIds = bundle.candidates.map((candidate) => candidate.id);
    const candidateChannels = bundle.candidates.map(
      (candidate) => candidate.channel,
    );
    const presentationIds = bundle.presentations.map(
      (presentation) => presentation.candidateId,
    );
    const policyIds = bundle.policy.map((decision) => decision.candidateId);
    const duplicate = (values: readonly string[]): boolean =>
      new Set(values).size !== values.length;
    const sameMembers = (
      left: readonly string[],
      right: readonly string[],
    ): boolean => {
      if (left.length !== right.length) return false;
      const sortedLeft = [...left].sort();
      const sortedRight = [...right].sort();
      return sortedLeft.every(
        (value, index) => value === sortedRight[index],
      );
    };

    if (duplicate(candidateIds) || duplicate(candidateChannels)) {
      context.addIssue({
        code: "custom",
        message: "Marketing candidates must have unique ids and channels.",
        path: ["candidates"],
      });
    }
    if (
      duplicate(presentationIds) ||
      !sameMembers(candidateIds, presentationIds)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Every marketing candidate must have exactly one matching presentation.",
        path: ["presentations"],
      });
    }
    if (duplicate(policyIds) || !sameMembers(candidateIds, policyIds)) {
      context.addIssue({
        code: "custom",
        message:
          "Every marketing candidate must have exactly one matching policy decision.",
        path: ["policy"],
      });
    }
    if (!sameMembers(candidateChannels, bundle.request.channels)) {
      context.addIssue({
        code: "custom",
        message: "Candidate channels must exactly match the requested channels.",
        path: ["candidates"],
      });
    }
    const replyRequest = bundle.request.kind === "community_reply";
    const substackCandidate = bundle.candidates.find(
      (candidate) => candidate.channel === "substack",
    );
    const substackPresentation = bundle.presentations.find(
      (presentation) => presentation.channel === "substack",
    );
    const requestsSubstack = bundle.request.channels.includes("substack");
    if (
      requestsSubstack
        ? !bundle.tutorialHandoff
          || bundle.tutorialHandoff.tutorialId !== bundle.request.tutorialId
          || !substackCandidate
          || !substackPresentation
          || substackCandidate.action !== "prepare_tutorial"
          || substackCandidate.body !== bundle.tutorialHandoff.bodyMarkdown
          || JSON.stringify(substackCandidate.links)
            !== JSON.stringify(bundle.tutorialHandoff.links)
          || JSON.stringify(substackCandidate.claims)
            !== JSON.stringify(bundle.tutorialHandoff.claims)
          || JSON.stringify(substackCandidate.topics)
            !== JSON.stringify(bundle.tutorialHandoff.topics)
          || JSON.stringify(substackCandidate.disclosures)
            !== JSON.stringify(bundle.tutorialHandoff.disclosures)
          || substackPresentation.candidateId !== substackCandidate.id
          || substackPresentation.title !== bundle.tutorialHandoff.title
          || substackPresentation.subtitle !== bundle.tutorialHandoff.subtitle
          || JSON.stringify(substackPresentation.tags)
            !== JSON.stringify(bundle.tutorialHandoff.tags)
        : bundle.tutorialHandoff !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The Substack candidate must exactly match its source-controlled tutorial handoff.",
        path: ["tutorialHandoff"],
      });
    }
    if (
      replyRequest
        ? bundle.sourcePacket.interaction?.id !==
          bundle.request.interactionReference
        : bundle.sourcePacket.interaction !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The verified interaction must exactly match the requested community reply.",
        path: ["sourcePacket", "interaction"],
      });
    }

    for (const candidate of bundle.candidates) {
      const presentation = bundle.presentations.find(
        (entry) => entry.candidateId === candidate.id,
      );
      const requiredChannelLink = candidate.channel === "x"
        || candidate.channel === "discord"
        ? bundle.request.requiredChannelLinks?.[candidate.channel]
        : undefined;
      if (
        candidate.kind !== bundle.request.kind ||
        JSON.stringify(candidate.sourcePacket) !==
          JSON.stringify(bundle.sourcePacket) ||
        JSON.stringify(candidate.interaction) !==
          JSON.stringify(bundle.sourcePacket.interaction)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Candidate kind, evidence, and interaction must match the reviewed bundle.",
          path: ["candidates"],
        });
      }
      if (
        replyRequest
          ? candidate.channel !== "x" || candidate.action !== "reply"
          : candidate.action === "reply"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Only an explicitly requested, verified community reply may use the reply action.",
          path: ["candidates"],
        });
      }
      if (!presentation || presentation.channel !== candidate.channel) {
        context.addIssue({
          code: "custom",
          message: "Candidate and presentation channels must match.",
          path: ["presentations"],
        });
        continue;
      }
      if (
        requiredChannelLink
        && (
          !candidate.links.includes(requiredChannelLink)
          || !marketingBodyContainsExactUrl(candidate.body, requiredChannelLink)
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Every required channel link must remain exact in both reviewed body copy and candidate links.",
          path: ["candidates"],
        });
      }
      if (
        candidate.channel === "substack"
          ? !presentation.title ||
            !presentation.tags ||
            presentation.tags.length < 2 ||
            new Set(presentation.tags.map((tag) => tag.toLowerCase())).size !==
              presentation.tags.length ||
            Array.from(candidate.body).length < 300
          : Boolean(
              presentation.title ||
                presentation.subtitle ||
                presentation.tags,
            )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Substack requires at least 300 characters, a title, and 2-5 unique tags; other channels cannot carry presentation metadata.",
          path: ["presentations"],
        });
      }
    }

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
    tutorialApproval: SourceControlledTutorialApprovalReceiptSchema.optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.decision === "reject" && approval.tutorialApproval) {
      context.addIssue({
        code: "custom",
        message: "A rejected draft cannot carry a tutorial approval receipt.",
        path: ["tutorialApproval"],
      });
    }
    if (
      approval.tutorialApproval
      && approval.tutorialApproval.approvedBy !== approval.approvedBy
    ) {
      context.addIssue({
        code: "custom",
        message: "Tutorial and workflow approvals must have the same owner.",
        path: ["tutorialApproval", "approvedBy"],
      });
    }
  });

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
      state: z.enum([
        "auto_authorized",
        "awaiting_approval",
        "blocked",
        "dry_run_complete",
      ]),
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
