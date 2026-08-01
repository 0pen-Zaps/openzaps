import "server-only";

import { createHash, createHmac } from "node:crypto";

import { readMarketingConfig } from "@/lib/marketing/config";
import type { XComplianceHealth } from "@/lib/marketing/x-compliance-server";

const X_ACCOUNT_ID = /^\d{1,19}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const MAX_MENTION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MIN_HASH_SECRET_LENGTH = 32;
const MAX_AUTO_REPLY_DAILY_CAP = 5;

type Environment = Readonly<Record<string, string | undefined>>;

export const X_MENTION_TEMPLATE_VERSION = 1 as const;

export const X_MENTION_TEMPLATE_IDS = [
  "about-v1",
  "agent-authority-v1",
  "docs-v1",
  "request-zap-v1",
  "virtual-trading-v1",
] as const;

export type XMentionTemplateId = (typeof X_MENTION_TEMPLATE_IDS)[number];

export type XMentionClassification =
  | XMentionTemplateId
  | "opt_out"
  | "review_only"
  | "blocked_external_link"
  | "blocked_media"
  | "blocked_protected"
  | "blocked_repost"
  | "blocked_sensitive"
  | "blocked_stale"
  | "blocked_self"
  | "blocked_withheld"
  | "blocked_invalid";

export interface XMentionForClassification {
  id: string;
  authorId: string;
  conversationId: string;
  text: string;
  createdAt: string;
  possiblySensitive: boolean;
  authorProtected: boolean;
  isWithheld: boolean;
  hasMedia: boolean;
  hasExternalLink: boolean;
  isRepost: boolean;
}

export interface XMentionClassificationResult {
  classification: XMentionClassification;
  eligibleForAutomaticReply: boolean;
  templateId: XMentionTemplateId | null;
  reason: string;
}

export interface XMentionAutomationConfig {
  ingestRequested: boolean;
  autoReplyRequested: boolean;
  autoResponseApproved: boolean;
  commercialUseApproved: boolean;
  complianceAttested: boolean;
  complianceReady: boolean;
  complianceHealth: XComplianceHealth["result"] | "unavailable";
  complianceValidUntil: string | null;
  templateApprovalDigestValid: boolean;
  templateRegistryDigest: string;
  hashSecretConfigured: boolean;
  ingestReady: boolean;
  autoReplyReady: boolean;
  dailyCap: number;
  blockers: string[];
}

const AUTOMATIC_REPLY_TEMPLATES: Readonly<Record<XMentionTemplateId, string>> = {
  "about-v1":
    "OpenZaps lets an owner pre-commit one bounded onchain workflow. An agent may hold the trigger but cannot widen the signed route, recipient, asset, amount, calldata, cadence, or limits. https://www.0xzaps.com/docs\n\nPre-audit. Reply @0xzaps stop to opt out.",
  "agent-authority-v1":
    "Give the agent the trigger, never the authority. It may submit a due run, but the signed recipient, route, asset, amount, calldata, cadence, and safety limits stay fixed. https://www.0xzaps.com/docs\n\nPre-audit. Reply @0xzaps stop to opt out.",
  "docs-v1":
    "OpenZaps docs: https://www.0xzaps.com/docs\n\nOpenZaps is pre-audit software. Verify before use. Reply @0xzaps stop to opt out.",
  "request-zap-v1":
    "Request a Zap and get a human-reviewed authority map for one bounded workflow: https://www.0xzaps.com/request-a-zap\n\nThis is not an automatic deployment promise. Reply @0xzaps stop to opt out.",
  "virtual-trading-v1":
    "Try Virtual Trading with 10,000 virtual USDG—no wallet, deposit, approval, signature, transaction, or real funds: https://www.0xzaps.com/virtual-trading\n\nReply @0xzaps stop to opt out.",
};

export const X_MENTION_TEMPLATE_REGISTRY_DIGEST = createHash("sha256")
  .update(JSON.stringify({
    version: X_MENTION_TEMPLATE_VERSION,
    templates: X_MENTION_TEMPLATE_IDS.map((templateId) => ({
      templateId,
      body: AUTOMATIC_REPLY_TEMPLATES[templateId],
    })),
  }))
  .digest("hex");

const SENSITIVE_OR_AMBIGUOUS =
  /\b(?:abuse|address|airdrop|audit|audited|bug|buy|collab(?:orate|oration)?|email|exploit|hack(?:ed|ing)?|incident|investment|legal|outage|partner(?:ship)?|phone|price|private key|profit|revenue|safe|seed phrase|sell|security|token|trading|vulnerab\w*|yield)\b/iu;
const PROFANITY_OR_HARASSMENT =
  /\b(?:asshole|bitch|cunt|doxx?|fuck|kill|nigger|retard|shit)\w*\b/iu;

function strictBoolean(
  env: Environment,
  key: string,
): { value: boolean; error: string | null } {
  const raw = env[key];
  if (raw === undefined || raw === "false") return { value: false, error: null };
  if (raw === "true") return { value: true, error: null };
  return { value: false, error: `${key} must be exactly "true" or "false".` };
}

function automaticReplyDailyCap(
  env: Environment,
): { value: number; error: string | null } {
  const raw = env.OPENZAPS_X_AUTO_REPLY_DAILY_CAP;
  if (raw === undefined) return { value: 1, error: null };
  if (!/^\d+$/u.test(raw)) {
    return {
      value: 0,
      error: `OPENZAPS_X_AUTO_REPLY_DAILY_CAP must be an integer from 0 to ${MAX_AUTO_REPLY_DAILY_CAP}.`,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_AUTO_REPLY_DAILY_CAP) {
    return {
      value: 0,
      error: `OPENZAPS_X_AUTO_REPLY_DAILY_CAP must be an integer from 0 to ${MAX_AUTO_REPLY_DAILY_CAP}.`,
    };
  }
  return { value, error: null };
}

function validHashSecret(value: string | undefined): value is string {
  return Boolean(
    value
    && value.length >= MIN_HASH_SECRET_LENGTH
    && value.length <= 4_096
    && !/[\r\n]/u.test(value),
  );
}

export function readXMentionAutomationConfig(
  env: Environment = process.env,
  complianceHealth: XComplianceHealth | null = null,
  nowMs = Date.now(),
): XMentionAutomationConfig {
  const ingest = strictBoolean(env, "OPENZAPS_X_MENTION_INGEST_ENABLED");
  const autoReply = strictBoolean(env, "OPENZAPS_X_AUTO_REPLY_ENABLED");
  const approval = strictBoolean(env, "OPENZAPS_X_AUTO_RESPONSE_APPROVED");
  const commercialUse = strictBoolean(
    env,
    "OPENZAPS_X_COMMERCIAL_USE_APPROVED",
  );
  const compliance = strictBoolean(env, "OPENZAPS_X_COMPLIANCE_READY");
  const cap = automaticReplyDailyCap(env);
  const marketing = readMarketingConfig(env);
  const effectiveDailyCap = Math.min(
    cap.value,
    marketing.dailyCaps.xReplies,
  );
  const hashSecretConfigured = validHashSecret(
    env.OPENZAPS_X_MENTION_HASH_SECRET,
  );
  const templateApprovalDigestValid =
    env.OPENZAPS_X_AUTO_RESPONSE_APPROVAL_DIGEST
      === X_MENTION_TEMPLATE_REGISTRY_DIGEST;
  const errors = [
    ingest.error,
    autoReply.error,
    approval.error,
    commercialUse.error,
    compliance.error,
    cap.error,
  ].filter((error): error is string => error !== null);
  const blockers = [...errors];
  const complianceValidUntilMs = complianceHealth?.validUntil
    ? Date.parse(complianceHealth.validUntil)
    : Number.NaN;
  const operationalComplianceReady = Boolean(
    complianceHealth
    && complianceHealth.result === "healthy"
    && !complianceHealth.hold
    && Number.isFinite(complianceValidUntilMs)
    && complianceValidUntilMs > nowMs,
  );

  if (ingest.value && !hashSecretConfigured) {
    blockers.push(
      `OPENZAPS_X_MENTION_HASH_SECRET must be a server-only secret of at least ${MIN_HASH_SECRET_LENGTH} characters.`,
    );
  }
  if (ingest.value && !commercialUse.value) {
    blockers.push(
      "X mention ingestion requires recorded X commercial-use approval for this use case.",
    );
  }
  if (ingest.value && !compliance.value) {
    blockers.push(
      "X mention ingestion requires the operator compliance-monitor attestation.",
    );
  }
  if (ingest.value && compliance.value && !operationalComplianceReady) {
    blockers.push(
      complianceHealth
        ? `X mention ingestion requires a fresh healthy compliance checkpoint; current state is ${complianceHealth.result}.`
        : "X mention ingestion requires a fresh healthy compliance checkpoint from the durable store.",
    );
  }
  if (ingest.value && !marketing.readiness.durableLedgerConfigured) {
    blockers.push("X mention ingestion requires the bound durable marketing database.");
  }
  if (ingest.value && !marketing.readiness.configurationValid) {
    blockers.push("X mention ingestion requires a valid global marketing configuration.");
  }
  if (ingest.value && !marketing.readiness.channels.x) {
    blockers.push("X mention ingestion requires the bound X user-context identity.");
  }
  if (ingest.value && (!marketing.enabled || marketing.dryRun)) {
    blockers.push("X mention ingestion requires the live marketing service.");
  }
  if (autoReply.value && !ingest.value) {
    blockers.push("Automatic X replies require X mention ingestion.");
  }
  if (autoReply.value && !approval.value) {
    blockers.push(
      "Automatic X replies require a recorded X auto-response campaign approval attestation.",
    );
  }
  if (autoReply.value && !templateApprovalDigestValid) {
    blockers.push(
      "Automatic X replies require approval of the exact current template registry digest.",
    );
  }
  if (approval.value && !marketing.xAutomatedLabelConfirmed) {
    blockers.push(
      "Automatic X replies require the automated-account label attestation.",
    );
  }
  if (autoReply.value && marketing.dailyCaps.xReplies < 1) {
    blockers.push(
      "Automatic X replies require OPENZAPS_MARKETING_DAILY_X_REPLY_CAP to be at least 1.",
    );
  }

  const ingestReady =
    ingest.value
    && errors.length === 0
    && hashSecretConfigured
    && commercialUse.value
    && compliance.value
    && operationalComplianceReady
    && marketing.readiness.configurationValid
    && marketing.enabled
    && !marketing.dryRun
    && marketing.readiness.durableLedgerConfigured
    && marketing.readiness.channels.x;
  const autoReplyReady =
    ingestReady
    && autoReply.value
    && approval.value
    && templateApprovalDigestValid
    && marketing.xAutomatedLabelConfirmed
    && effectiveDailyCap > 0;

  return {
    ingestRequested: ingest.value,
    autoReplyRequested: autoReply.value,
    autoResponseApproved: approval.value,
    commercialUseApproved: commercialUse.value,
    complianceAttested: compliance.value,
    complianceReady: compliance.value && operationalComplianceReady,
    complianceHealth: complianceHealth?.result ?? "unavailable",
    complianceValidUntil: complianceHealth?.validUntil ?? null,
    templateApprovalDigestValid,
    templateRegistryDigest: X_MENTION_TEMPLATE_REGISTRY_DIGEST,
    hashSecretConfigured,
    ingestReady,
    autoReplyReady,
    dailyCap: effectiveDailyCap,
    blockers,
  };
}

function promptForms(
  text: string,
  expectedUsername: string,
): { exactPrompt: string | null; optOutPrompt: string; reviewPrompt: string } {
  const withoutMentions = text.replace(
    new RegExp(`@${expectedUsername}\\b`, "giu"),
    " ",
  );
  const canonical = withoutMentions
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/gu, "'");
  const optOutPrompt = canonical
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const exactSafe = /^[a-z0-9/'\-\s]+[?.!]*$/u.test(canonical.trim());
  const exactPrompt = exactSafe
    ? canonical
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/[?.!]+$/gu, "")
        .trim()
    : null;
  return {
    exactPrompt,
    optOutPrompt,
    reviewPrompt: canonical.replace(/\s+/gu, " ").trim(),
  };
}

function deterministicTemplate(prompt: string): XMentionTemplateId | null {
  if (
    /^(?:\/docs|docs|documentation|where (?:are|can i find) (?:the )?docs)$/u.test(
      prompt,
    )
  ) return "docs-v1";
  if (
    /^(?:\/request|request|request a zap|how (?:can|do) i request a zap|where can i request a zap)$/u.test(
      prompt,
    )
  ) return "request-zap-v1";
  if (
    /^(?:\/virtual|virtual|virtual trading|how (?:can|do) i try virtual trading|where can i try virtual trading)$/u.test(
      prompt,
    )
  ) return "virtual-trading-v1";
  if (
    /^(?:\/agent|agent|agent authority|how do agents work|what can an agent (?:change|do)|what authority does an agent have)$/u.test(
      prompt,
    )
  ) return "agent-authority-v1";
  if (
    /^(?:\/about|about|what is openzaps|how does openzaps work|what is a zap)$/u.test(
      prompt,
    )
  ) return "about-v1";
  return null;
}

function isExplicitOptOut(prompt: string): boolean {
  return /^(?:(?:please|could you|can you|would you) )?(?:stop(?: (?:replying|responding|messaging|replies|responses|messages)(?: (?:to )?me)?)?|(?:don't|do not|never) (?:reply|respond|message)(?: (?:to )?me)?(?: again)?|unsubscribe(?: me)?|opt out|leave me alone|no more (?:replies|responses|messages))(?: please| thanks| thank you)?$/u.test(
    prompt,
  );
}

export function classifyXMention(
  mention: XMentionForClassification,
  options: { authenticatedAccountId: string; expectedUsername: string; nowMs?: number },
): XMentionClassificationResult {
  if (
    !/^\d{1,19}$/u.test(mention.id)
    || !X_ACCOUNT_ID.test(mention.authorId)
    || !X_ACCOUNT_ID.test(mention.conversationId)
    || !X_ACCOUNT_ID.test(options.authenticatedAccountId)
    || !/^[a-z0-9_]{1,15}$/u.test(options.expectedUsername)
    || !mention.text
    || mention.text.length > 10_000
  ) {
    return {
      classification: "blocked_invalid",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "invalid_metadata",
    };
  }
  if (mention.authorId === options.authenticatedAccountId) {
    return {
      classification: "blocked_self",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "authenticated_account",
    };
  }
  const prompts = promptForms(mention.text, options.expectedUsername);
  if (isExplicitOptOut(prompts.optOutPrompt)) {
    return {
      classification: "opt_out",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "explicit_opt_out",
    };
  }
  const createdAt = Date.parse(mention.createdAt);
  const nowMs = options.nowMs ?? Date.now();
  if (
    !Number.isFinite(createdAt)
    || nowMs - createdAt > MAX_MENTION_AGE_MS
    || createdAt - nowMs > MAX_CLOCK_SKEW_MS
  ) {
    return {
      classification: "blocked_stale",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "outside_24_hour_window",
    };
  }
  if (mention.isRepost) {
    return {
      classification: "blocked_repost",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "repost",
    };
  }
  if (mention.authorProtected) {
    return {
      classification: "blocked_protected",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "protected_author",
    };
  }
  if (mention.isWithheld) {
    return {
      classification: "blocked_withheld",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "withheld_post",
    };
  }
  if (mention.hasMedia) {
    return {
      classification: "blocked_media",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "media_present",
    };
  }
  if (mention.hasExternalLink) {
    return {
      classification: "blocked_external_link",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "external_link_present",
    };
  }
  if (mention.possiblySensitive) {
    return {
      classification: "blocked_sensitive",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "sensitive_or_ambiguous_topic",
    };
  }
  if (prompts.exactPrompt === null) {
    return {
      classification: "review_only",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "unsupported_prompt_characters",
    };
  }
  const templateId = deterministicTemplate(prompts.exactPrompt);
  if (templateId) {
    return {
      classification: templateId,
      eligibleForAutomaticReply: true,
      templateId,
      reason: "exact_reviewed_template",
    };
  }
  return SENSITIVE_OR_AMBIGUOUS.test(prompts.reviewPrompt)
    || PROFANITY_OR_HARASSMENT.test(prompts.reviewPrompt)
    ? {
        classification: "blocked_sensitive",
        eligibleForAutomaticReply: false,
        templateId: null,
        reason: "sensitive_or_ambiguous_topic",
      }
    : {
        classification: "review_only",
        eligibleForAutomaticReply: false,
        templateId: null,
        reason: "no_exact_template_match",
      };
}

export function xMentionContentHash(
  text: string,
  secret: string | undefined = process.env.OPENZAPS_X_MENTION_HASH_SECRET,
): string {
  if (!validHashSecret(secret) || !text || text.length > 10_000) {
    throw new Error("X mention content hashing is not configured.");
  }
  return createHmac("sha256", secret)
    .update(text, "utf8")
    .digest("hex");
}

export function isXMentionContentHash(value: string): boolean {
  return CONTENT_HASH.test(value);
}

export function renderXMentionReply(templateId: XMentionTemplateId): string {
  const body = AUTOMATIC_REPLY_TEMPLATES[templateId];
  if (!body || Array.from(body).length > 280) {
    throw new Error("The reviewed X mention template is invalid.");
  }
  return body;
}
