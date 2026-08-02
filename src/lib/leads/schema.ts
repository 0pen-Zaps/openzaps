import { z } from "zod";

import {
  normalizeAttributionCampaign,
  normalizeAttributionContent,
  normalizeAttributionMedium,
  normalizeAttributionSource,
} from "@/lib/marketing/campaign-attribution";

export const LEAD_PERSONAS = [
  "agent_builder",
  "protocol_team",
  "defi_user",
] as const;

export const LEAD_TIMELINES = [
  "immediately",
  "within_30_days",
  "within_90_days",
  "exploring",
] as const;

export const LEAD_REQUEST_FORM_FIELDS = [
  "persona",
  "name",
  "email",
  "project",
  "projectUrl",
  "workflow",
  "protocolsAssets",
  "trigger",
  "guardrails",
  "timeline",
  "consent",
] as const;

export type LeadRequestFormField = (typeof LEAD_REQUEST_FORM_FIELDS)[number];

const LEAD_REQUEST_FORM_FIELD_SET = new Set<string>(
  LEAD_REQUEST_FORM_FIELDS,
);

/**
 * Reduce a schema failure to one allowlisted browser-editable field. Never
 * expose submitted values, attribution internals, trap fields, or unknown
 * object keys in the public response.
 */
export function firstLeadRequestFormIssue(
  error: z.ZodError,
): LeadRequestFormField | undefined {
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (
      typeof field === "string"
      && LEAD_REQUEST_FORM_FIELD_SET.has(field)
    ) {
      return field as LeadRequestFormField;
    }
  }
  return undefined;
}

const optionalTrimmedString = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().trim().min(1).max(maximum).optional(),
  );

const controlledAttributionValue = (
  normalizer: (value: unknown) => string | null,
  maximum: number,
) => z.preprocess(
  (value) => normalizer(value) ?? undefined,
  z.string().max(maximum).optional(),
);

const optionalHttpsUrl = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z
      .string()
      .trim()
      .max(maximum)
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:"
            && url.username.length === 0
            && url.password.length === 0
          );
        } catch {
          return false;
        }
      }, "A credential-free HTTPS URL is required.")
      .optional(),
  );

const optionalHttpsReferrer = optionalHttpsUrl(500).transform((value) => {
  if (!value) return value;
  return new URL(value).origin;
}).optional();

export const LeadAttributionSchema = z
  .object({
    utmSource: controlledAttributionValue(normalizeAttributionSource, 80),
    utmMedium: controlledAttributionValue(normalizeAttributionMedium, 80),
    utmCampaign: controlledAttributionValue(normalizeAttributionCampaign, 120),
    utmContent: controlledAttributionValue(normalizeAttributionContent, 120),
    // Search terms are unbounded user text and can contain personal data. The
    // key remains accepted for compatibility, but its value is never retained.
    utmTerm: z.preprocess(() => undefined, z.string().max(120).optional()),
    entryPoint: z.enum(["builder_review"]).optional(),
    // Paths, query strings, and fragments can carry incidental identifiers.
    // The referring origin is sufficient for attribution, so discard the rest
    // at the server boundary before persistence.
    referrer: optionalHttpsReferrer,
    landingPath: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim().length === 0
          ? undefined
          : value,
      z
        .string()
        .trim()
        .min(1)
        .max(300)
        .regex(/^\/(?!\/)[^\u0000-\u001f\u007f]*$/u)
        .optional(),
    ),
  })
  .strict();

export const LeadRequestSchema = z
  .object({
    persona: z.enum(LEAD_PERSONAS),
    name: z.string().trim().min(2).max(100),
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform((value) => value.toLowerCase()),
    project: optionalTrimmedString(120),
    projectUrl: optionalHttpsUrl(500),
    workflow: z.string().trim().min(20).max(4000),
    protocolsAssets: optionalTrimmedString(2000),
    trigger: z.string().trim().min(3).max(2000),
    guardrails: z.string().trim().min(10).max(2000),
    timeline: z.enum(LEAD_TIMELINES),
    consent: z.literal(true),
    website: z.string().trim().max(200).optional().default(""),
    attribution: LeadAttributionSchema.optional().default({}),
  })
  .strict();

export type LeadPersona = (typeof LEAD_PERSONAS)[number];
export type LeadTimeline = (typeof LEAD_TIMELINES)[number];
export type LeadRequest = z.output<typeof LeadRequestSchema>;
export type LeadAttribution = z.output<typeof LeadAttributionSchema>;
