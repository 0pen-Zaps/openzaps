import "server-only";

import { Resend } from "resend";
import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse,
} from "resend";
import { z } from "zod";

import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import {
  LEAD_PERSONAS,
  LEAD_TIMELINES,
} from "@/lib/leads/schema";

export const LEAD_NOTIFICATION_RECIPIENT =
  "nodar.janashia@gmail.com" as const;
export const LEAD_NOTIFICATION_EMAIL_SUBJECT =
  "New OpenZaps form submission" as const;
export const DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL =
  "https://www.0xzaps.com/marketing" as const;

const WITHHELD_FIELD = "[withheld: credential-like data detected]";
const NOT_PROVIDED = "(not provided)";
const RESEND_API_KEY = /^re_[A-Za-z0-9_-]{16,}$/u;
const PROVIDER_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const ALLOWED_OPERATOR_ORIGINS = new Set([
  "https://0xzaps.com",
  "https://www.0xzaps.com",
]);

const optionalClaimedText = (maximum: number) =>
  z.string().min(1).max(maximum).nullable();

const ClaimedProjectUrlSchema = z
  .string()
  .max(500)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:"
        && !url.username
        && !url.password
      );
    } catch {
      return false;
    }
  }, "A credential-free HTTPS URL is required.")
  .nullable();

/**
 * The complete, private row returned by the lead-notification claim RPC.
 *
 * Deliberately excluded: attribution, request fingerprints, network metadata,
 * consent metadata, quotas, and provider state.
 */
export const ClaimedLeadEmailSchema = z
  .object({
    lead_id: z.string().uuid(),
    persona: z.enum(LEAD_PERSONAS),
    name: z.string().min(2).max(100),
    email: z
      .string()
      .min(3)
      .max(254)
      .email()
      .refine((value) => value === value.toLowerCase()),
    project: optionalClaimedText(120),
    project_url: ClaimedProjectUrlSchema,
    workflow: z.string().min(20).max(4000),
    protocols_assets: optionalClaimedText(2000),
    trigger_description: z.string().min(3).max(2000),
    guardrails: z.string().min(10).max(2000),
    timeline: z.enum(LEAD_TIMELINES),
    qualification_score: z.number().int().min(0).max(5),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ClaimedLeadEmail = z.output<typeof ClaimedLeadEmailSchema>;

export type LeadNotificationEmailEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface LeadNotificationEmailConfig {
  apiKey: string;
  from: string;
  operatorUrl: string;
  to: typeof LEAD_NOTIFICATION_RECIPIENT;
}

export type LeadNotificationEmailErrorCode =
  | "not-configured"
  | "invalid-input"
  | "network-error"
  | "provider-error"
  | "invalid-response";

/**
 * A deliberately small, secret-free error surface for durable workflow
 * retries. Provider response bodies and configuration values are never copied
 * into this error.
 */
export class LeadNotificationEmailError extends Error {
  constructor(
    readonly code: LeadNotificationEmailErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(messageForEmailError(code, status));
    this.name = "LeadNotificationEmailError";
  }
}

export interface LeadNotificationEmailClient {
  emails: {
    send(
      payload: CreateEmailOptions,
      options?: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
  };
}

export interface SendLeadNotificationEmailDependencies {
  env?: LeadNotificationEmailEnvironment;
  client?: LeadNotificationEmailClient;
}

export interface RenderedLeadNotificationEmail {
  subject: typeof LEAD_NOTIFICATION_EMAIL_SUBJECT;
  text: string;
}

function messageForEmailError(
  code: LeadNotificationEmailErrorCode,
  status?: number,
): string {
  if (code === "not-configured") {
    return "Lead notification email is not configured.";
  }
  if (code === "invalid-input") {
    return "Lead notification email input is invalid.";
  }
  if (code === "network-error") {
    return "Lead notification email provider could not be reached.";
  }
  if (code === "invalid-response") {
    return "Lead notification email provider returned an invalid response.";
  }
  return status === undefined
    ? "Lead notification email provider request failed."
    : `Lead notification email provider request failed with status ${status}.`;
}

function configurationError(): LeadNotificationEmailError {
  return new LeadNotificationEmailError("not-configured", false);
}

function isMailbox(value: string): boolean {
  if (
    value.length < 3
    || value.length > 254
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    return false;
  }

  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local
    || local.length > 64
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
    || !domain
    || domain.length > 253
  ) {
    return false;
  }

  const labels = domain.split(".");
  if (
    labels.length < 2
    || !/^[A-Za-z]{2,63}$/u.test(labels.at(-1) ?? "")
  ) {
    return false;
  }
  return labels.every(
    (label) =>
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label),
  );
}

function isFromAddress(value: string): boolean {
  if (
    value !== value.trim()
    || value.length > 320
    || /[\r\n]/u.test(value)
  ) {
    return false;
  }

  if (isMailbox(value)) return true;
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9 .'-]{0,79}) <([^<>]+)>$/u);
  return Boolean(match && isMailbox(match[2]));
}

function normalizeOperatorUrl(raw: string | undefined): string | null {
  const value = raw ?? DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL;
  if (value !== value.trim() || /[\r\n]/u.test(value)) return null;

  try {
    const url = new URL(value);
    if (
      !ALLOWED_OPERATOR_ORIGINS.has(url.origin)
      || url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Read the server-only sending configuration.
 *
 * The exact enable value is mandatory. Disabled and malformed configuration
 * fail closed with the same secret-free, permanent error.
 */
export function readLeadNotificationEmailConfig(
  env: LeadNotificationEmailEnvironment = process.env,
): LeadNotificationEmailConfig {
  if (
    env.VERCEL_ENV !== "production"
    || env.OPENZAPS_LEAD_NOTIFICATION_ENABLED !== "true"
  ) {
    throw configurationError();
  }

  const apiKey = env.RESEND_API_KEY;
  const from = env.OPENZAPS_LEAD_NOTIFICATION_FROM;
  const operatorUrl = normalizeOperatorUrl(
    env.OPENZAPS_LEAD_NOTIFICATION_OPERATOR_URL,
  );

  if (
    !apiKey
    || apiKey !== apiKey.trim()
    || !RESEND_API_KEY.test(apiKey)
    || env.OPENZAPS_LEAD_NOTIFICATION_TO !== LEAD_NOTIFICATION_RECIPIENT
    || !from
    || !isFromAddress(from)
    || !operatorUrl
  ) {
    throw configurationError();
  }

  return {
    apiKey,
    from,
    operatorUrl,
    to: LEAD_NOTIFICATION_RECIPIENT,
  };
}

/**
 * Non-throwing advisory readiness check for request and recovery routes.
 */
export function leadNotificationEmailConfigured(
  env: LeadNotificationEmailEnvironment = process.env,
): boolean {
  try {
    readLeadNotificationEmailConfig(env);
    return true;
  } catch {
    return false;
  }
}

function normalizeText(value: string, maximum: number): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, maximum);
}

function renderFreeText(value: string, maximum: number): string {
  if (containsCredentialLikeData(value)) return WITHHELD_FIELD;
  return normalizeText(value, maximum);
}

function renderOptionalFreeText(
  value: string | null,
  maximum: number,
): string {
  return value === null ? NOT_PROVIDED : renderFreeText(value, maximum);
}

function renderProjectUrl(value: string | null): string {
  if (value === null) return NOT_PROVIDED;

  const url = new URL(value);
  url.search = "";
  url.hash = "";
  const normalized = url.toString().slice(0, 500);
  return containsCredentialLikeData(normalized)
    ? WITHHELD_FIELD
    : normalized;
}

function parseClaimedLead(input: ClaimedLeadEmail): ClaimedLeadEmail {
  const parsed = ClaimedLeadEmailSchema.safeParse(input);
  if (!parsed.success) {
    throw new LeadNotificationEmailError("invalid-input", false);
  }
  return parsed.data;
}

export function renderLeadNotificationEmail(
  input: ClaimedLeadEmail,
  operatorUrl: string = DEFAULT_LEAD_NOTIFICATION_OPERATOR_URL,
): RenderedLeadNotificationEmail {
  const lead = parseClaimedLead(input);
  const normalizedOperatorUrl = normalizeOperatorUrl(operatorUrl);
  if (!normalizedOperatorUrl) {
    throw new LeadNotificationEmailError("invalid-input", false);
  }

  const text = [
    "A new Zap request was accepted by OpenZaps.",
    "",
    "Submission",
    `Lead ID: ${lead.lead_id}`,
    `Received: ${new Date(lead.created_at).toISOString()}`,
    `Qualification score: ${lead.qualification_score}/5`,
    `Persona: ${lead.persona}`,
    `Timeline: ${lead.timeline}`,
    "",
    "Contact",
    `Name: ${renderFreeText(lead.name, 100)}`,
    `Email: ${lead.email}`,
    `Project: ${renderOptionalFreeText(lead.project, 120)}`,
    `Project URL: ${renderProjectUrl(lead.project_url)}`,
    "",
    "Requested workflow",
    renderFreeText(lead.workflow, 4000),
    "",
    "Protocols / assets",
    renderOptionalFreeText(lead.protocols_assets, 2000),
    "",
    "Trigger",
    renderFreeText(lead.trigger_description, 2000),
    "",
    "Guardrails",
    renderFreeText(lead.guardrails, 2000),
    "",
    `Review privately: ${normalizedOperatorUrl}`,
  ].join("\n");

  return {
    subject: LEAD_NOTIFICATION_EMAIL_SUBJECT,
    text,
  };
}

export function leadNotificationIdempotencyKey(leadId: string): string {
  const parsed = z.string().uuid().safeParse(leadId);
  if (!parsed.success) {
    throw new LeadNotificationEmailError("invalid-input", false);
  }
  return `lead-submission/${parsed.data}`;
}

export function isRetryableLeadNotificationProviderStatus(
  status: number | null | undefined,
): boolean {
  return typeof status === "number" && status >= 400 && status <= 599;
}

function safeProviderStatus(value: unknown): number | undefined {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 400
    && value <= 599
  ) {
    return value;
  }
  return undefined;
}

function statusFromThrownProviderError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return (
    safeProviderStatus(candidate.statusCode)
    ?? safeProviderStatus(candidate.status)
  );
}

function nameFromThrownProviderError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as { name?: unknown };
  return typeof candidate.name === "string" ? candidate.name : "";
}

function retryableProviderName(name: string): boolean {
  return [
    "application_error",
    "concurrent_idempotent_requests",
    "internal_server_error",
    "rate_limit_exceeded",
  ].includes(name);
}

function retryableProviderResponse(
  name: string,
  status: number | undefined,
): boolean {
  if (name === "concurrent_idempotent_requests") return true;
  if (name === "invalid_idempotent_request") return false;
  return status === undefined
    ? retryableProviderName(name)
    : isRetryableLeadNotificationProviderStatus(status);
}

export async function sendLeadNotificationEmail(
  input: ClaimedLeadEmail,
  dependencies: SendLeadNotificationEmailDependencies = {},
): Promise<string> {
  const lead = parseClaimedLead(input);
  const config = readLeadNotificationEmailConfig(
    dependencies.env ?? process.env,
  );
  const rendered = renderLeadNotificationEmail(lead, config.operatorUrl);
  const client = dependencies.client ?? new Resend(config.apiKey);

  let response: CreateEmailResponse;
  try {
    response = await client.emails.send(
      {
        from: config.from,
        to: config.to,
        subject: rendered.subject,
        text: rendered.text,
      },
      {
        idempotencyKey: leadNotificationIdempotencyKey(lead.lead_id),
      },
    );
  } catch (error) {
    const status = statusFromThrownProviderError(error);
    if (status === undefined) {
      throw new LeadNotificationEmailError("network-error", true);
    }
    throw new LeadNotificationEmailError(
      "provider-error",
      retryableProviderResponse(
        nameFromThrownProviderError(error),
        status,
      ),
      status,
    );
  }

  if (response.error) {
    const status = safeProviderStatus(response.error.statusCode);
    throw new LeadNotificationEmailError(
      "provider-error",
      retryableProviderResponse(response.error.name, status),
      status,
    );
  }

  const providerMessageId = response.data?.id;
  if (
    typeof providerMessageId !== "string"
    || !PROVIDER_MESSAGE_ID.test(providerMessageId)
    || containsCredentialLikeData(providerMessageId)
  ) {
    throw new LeadNotificationEmailError("invalid-response", true);
  }
  return providerMessageId;
}
