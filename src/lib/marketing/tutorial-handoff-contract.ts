import { z } from "zod";

import {
  MarketingClaimSchema,
  MarketingDisclosureSchema,
  MarketingTopicSchema,
} from "@/lib/marketing/schemas";

export const SOURCE_CONTROLLED_TUTORIAL_BUNDLE_VERSION = 1 as const;
export const SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER =
  "<!-- OPENZAPS_SUBSTACK_BODY -->" as const;
export const SOURCE_CONTROLLED_TUTORIAL_APPROVAL_STATEMENT =
  "Approve only these exact source and editor-body hashes for a human-only DeFi Tutorials handoff." as const;

const tutorialId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const canonicalSourcePath = z
  .string()
  .regex(/^docs\/tutorials\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u);

export const SourceControlledTutorialApprovalBundleSchema = z
  .object({
    version: z.literal(SOURCE_CONTROLLED_TUTORIAL_BUNDLE_VERSION),
    channel: z.literal("substack"),
    status: z.literal("requires_owner_approval"),
    tutorialId,
    manifestStatus: z.enum(["draft", "approved_handoff"]),
    sourcePath: canonicalSourcePath,
    sourceSha256: sha256,
    bodySha256: sha256,
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().min(1).max(300).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).min(2).max(5),
    topics: z.array(MarketingTopicSchema).min(1).max(8),
    disclosures: z.array(MarketingDisclosureSchema).max(2),
    claims: z.array(MarketingClaimSchema).max(24),
    links: z.array(z.string().url().max(2_048)).max(32),
    bodyMarkdown: z.string().min(300).max(250_000),
    editorUrl: z.literal("https://defitutorials.substack.com/publish/post"),
    publicationUrl: z.literal("https://defitutorials.substack.com"),
    modelRewriteAllowed: z.literal(false),
    apiWriteAttempted: z.literal(false),
    privateEndpointUsed: z.literal(false),
    approval: z
      .object({
        required: z.literal(true),
        decision: z.literal("pending"),
        scope: z.literal("exact_source_and_body_sha256"),
        tutorialId,
        sourceSha256: sha256,
        bodySha256: sha256,
        statement: z.literal(SOURCE_CONTROLLED_TUTORIAL_APPROVAL_STATEMENT),
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.sourcePath !== `docs/tutorials/${bundle.tutorialId}.md`) {
      context.addIssue({
        code: "custom",
        message: "Tutorial sourcePath must be derived from tutorialId.",
        path: ["sourcePath"],
      });
    }
    if (
      bundle.approval.tutorialId !== bundle.tutorialId
      || bundle.approval.sourceSha256 !== bundle.sourceSha256
      || bundle.approval.bodySha256 !== bundle.bodySha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Tutorial approval identity must match the exact draft bundle.",
        path: ["approval"],
      });
    }
    const normalizedTags = bundle.tags.map((tag) => tag.toLowerCase());
    if (new Set(normalizedTags).size !== normalizedTags.length) {
      context.addIssue({
        code: "custom",
        message: "Tutorial tags must be unique.",
        path: ["tags"],
      });
    }
    if (new Set(bundle.topics).size !== bundle.topics.length) {
      context.addIssue({
        code: "custom",
        message: "Tutorial topics must be unique.",
        path: ["topics"],
      });
    }
    if (new Set(bundle.disclosures).size !== bundle.disclosures.length) {
      context.addIssue({
        code: "custom",
        message: "Tutorial disclosures must be unique.",
        path: ["disclosures"],
      });
    }
    if (new Set(bundle.links).size !== bundle.links.length) {
      context.addIssue({
        code: "custom",
        message: "Tutorial links must be unique.",
        path: ["links"],
      });
    }
  });

export type SourceControlledTutorialApprovalBundle = z.infer<
  typeof SourceControlledTutorialApprovalBundleSchema
>;

export const SourceControlledTutorialApprovalReceiptSchema = z
  .object({
    decision: z.literal("approve"),
    approvedBy: z.string().trim().min(1).max(120),
    tutorialId,
    sourceSha256: sha256,
    bodySha256: sha256,
  })
  .strict();

export type SourceControlledTutorialApprovalReceipt = z.infer<
  typeof SourceControlledTutorialApprovalReceiptSchema
>;
