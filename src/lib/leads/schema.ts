import { z } from "zod";

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

const optionalTrimmedString = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().trim().min(1).max(maximum).optional(),
  );

const ATTRIBUTION_VALUE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._~+-]*$/u;
const SENSITIVE_ATTRIBUTION_PATTERN =
  /(?:@|https?:\/\/|www\.|\b0x[a-fA-F0-9]{40,64}\b|\b(?:sk-(?:proj-)?|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{8,})/iu;

const optionalAttributionValue = (maximum: number) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim();
    if (
      normalized.length === 0
      || normalized.length > maximum
      || !ATTRIBUTION_VALUE_PATTERN.test(normalized)
      || SENSITIVE_ATTRIBUTION_PATTERN.test(normalized)
    ) {
      return undefined;
    }
    return normalized;
  }, z.string().max(maximum).optional());

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
    utmSource: optionalAttributionValue(80),
    utmMedium: optionalAttributionValue(80),
    utmCampaign: optionalAttributionValue(120),
    utmContent: optionalAttributionValue(120),
    utmTerm: optionalAttributionValue(120),
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
