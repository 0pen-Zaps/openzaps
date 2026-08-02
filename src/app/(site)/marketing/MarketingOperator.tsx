"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  marketingRunIdFromSearch,
  parseMarketingSourceUrls,
} from "@/lib/marketing/operator-input";
import {
  leadScorecardAttributionDimensionIsValid,
  leadReviewSla,
  sortLeadsForReview,
  type LeadScorecard,
  type LeadScorecardAttribution,
  type LeadScorecardWindow,
} from "@/lib/leads/scorecard";
import {
  canonicalSubstackPostUrl,
  prepareSubstackRichText,
  substackDraftView,
  type SubstackRichText,
} from "@/lib/marketing/substack-handoff";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";
import {
  X_MENTION_APPROVAL_REGISTRY,
  X_MENTION_TEMPLATE_REGISTRY_DIGEST,
  type XMentionTemplateId as XActivationTemplateId,
} from "@/lib/marketing/x-mention-registry";
import styles from "./marketing.module.css";

const TOKEN_STORAGE_KEY = "openzaps:marketing:operator-token";
const LEAD_TOKEN_STORAGE_KEY = "openzaps:marketing:lead-desk-token";
const RUN_STORAGE_KEY = "openzaps:marketing:run-id";
const SYNDICATION_REPAIR_STORAGE_KEY =
  "openzaps:marketing:syndication-repair";
const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_INTERVAL_MS = 30_000;

const CHANNELS = ["x", "discord", "substack"] as const;
type Channel = (typeof CHANNELS)[number];
type DraftKind = "product_update" | "tutorial" | "community_reply";
type LeadStatus = "new" | "contacted" | "qualified" | "closed";
type SyndicationSource = "openzaps" | "defitutorials";
type SyndicationClassification = "reviewable" | "needs_classification";
type SyndicationStatus =
  | "baseline"
  | "pending"
  | "drafting"
  | "awaiting_approval"
  | "published"
  | "skipped"
  | "failed";
type JsonRecord = Record<string, unknown>;

export type SourceControlledTutorialSelection = {
  tutorialId: string;
  title: string;
  manifestStatus: "draft" | "approved_handoff";
  sourcePath: string;
  sourceSha256: string;
  bodySha256: string;
};

export type TutorialApprovalEcho = Pick<
  SourceControlledTutorialSelection,
  "tutorialId" | "sourceSha256" | "bodySha256"
>;

export type SubstackManifestEntry = {
  id: string;
  title: string;
  sourcePath: string;
  status: "rss_confirmed";
  canonicalUrl: string;
  publishedAt: string;
};

type SubstackVerificationBase = {
  runId: string;
  candidateId: string;
  canonicalUrl: string;
  approvedTitle: string;
  feedUrl: string;
  checkedAt: string;
  publishedAt?: string;
};

export type SubstackVerification =
  | (SubstackVerificationBase & {
      status: "rss_confirmed";
      publishedAt: string;
      persisted: true;
      receiptResult: "recorded" | "already_recorded";
      manifestEntry: SubstackManifestEntry;
      manifestPatch: string;
    })
  | (SubstackVerificationBase & {
      status: "not_found" | "title_mismatch";
      persisted: false;
    });

type OperatorError = Error & {
  status?: number;
  runId?: string;
  repairProof?: string;
};

export type XIdentityVerification = {
  authenticatedAccountId: string;
  authenticatedUsername: string;
  observedAt: string;
};

const X_ACTIVATION_PRIVACY_URL =
  "https://www.0xzaps.com/legal#request-data";
const X_AUTOMATIC_REPLY_SCOPE =
  "official mentions timeline only; exact reviewed deterministic commands; first-run baseline; one reply per interaction; opt-out; all other content remains review-only";

type XComplianceResult =
  | "healthy"
  | "stale"
  | "hold"
  | "not_initialized"
  | "account_not_found";

export type XActivationStatus = {
  evaluatedAt: string;
  expectedAccountIdentity: {
    accountId: string;
    username: string;
  } | null;
  privacyUrl: typeof X_ACTIVATION_PRIVACY_URL;
  automaticReplyScope: typeof X_AUTOMATIC_REPLY_SCOPE;
  templates: Array<{
    templateId: XActivationTemplateId;
    prompts: string[];
    body: string;
  }>;
  automation: {
    ingestRequested: boolean;
    autoReplyRequested: boolean;
    autoResponseApproved: boolean;
    commercialUseApproved: boolean;
    complianceAttested: boolean;
    complianceReady: boolean;
    complianceHealth: XComplianceResult | "unavailable";
    complianceValidUntil: string | null;
    templateApprovalDigestValid: boolean;
    templateRegistryDigest: string;
    hashSecretConfigured: boolean;
    canonicalUsernameBound: boolean;
    ingestReady: boolean;
    autoReplyReady: boolean;
    dailyCap: number;
    blockers: string[];
  };
  complianceHealth: {
    result: XComplianceResult;
    checkedAt: string | null;
    validUntil: string | null;
    subjectCount: number;
    nonPresentCount: number;
    hold: boolean;
  } | null;
  xReplyDailyCap: number;
  automatedLabelAttested: boolean;
};

export type DiscordCommandReadbackCounts = {
  desired: number;
  remote: number;
  create: number;
  update: number;
  delete: number;
};

export const DISCORD_PREFLIGHT_BUTTON_LABEL =
  "Verify Discord destination and command manifest";

export type DiscordActivationVerification = {
  destination: {
    schemaVersion: 1;
    channel: "discord";
    transport: "webhook" | "bot";
    scope: "configured_guild_channel";
    verified: true;
    mutationsPerformed: false;
  };
  commandReadback:
    | {
        schemaVersion: 1;
        status: "in_sync" | "drift";
        scope: "configured_application_guild";
        verified: true;
        providerReadbackVerified: true;
        managedCommandsInSync: boolean;
        guildPermissionVisibility: "unchecked";
        liveInvocationVerified: false;
        manifestSha256: string;
        managedReadbackSha256: string;
        counts: DiscordCommandReadbackCounts;
        writesPerformed: false;
      }
    | {
        schemaVersion: 1;
        status: "not_configured" | "unavailable";
        scope: "configured_application_guild";
        verified: false;
        providerReadbackVerified: false;
        managedCommandsInSync: false;
        guildPermissionVisibility: "unchecked";
        liveInvocationVerified: false;
        writesPerformed: false;
      };
  writesPerformed: false;
};

export type ReadinessRow = {
  key: string;
  label: string;
  ready: boolean;
  state: string;
  detail: string;
};

export type OperatorLead = {
  id: string;
  persona: string;
  name: string;
  email: string;
  emailVerified: boolean;
  project: string | null;
  projectUrl: string | null;
  workflow: string;
  protocolsAssets: string | null;
  trigger: string;
  guardrails: string;
  timeline: string;
  attribution: JsonRecord;
  qualificationScore: number;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type OperatorSyndicationItem = {
  itemId: string;
  source: SyndicationSource;
  title: string;
  canonicalUrl: string;
  publishedAt: string | null;
  classification: SyndicationClassification;
  status: SyndicationStatus;
  campaignSlug: string;
  workflowRunId: string | null;
  discoveredAt: string;
  updatedAt: string;
};

export type SyndicationRepairPair = {
  itemId: string;
  runId: string;
  repairProof: string;
};

type OperatorSessionResetReason = "explicit_forget" | "auth_rejected";

export function operatorResetClearsSyndicationRepair(
  reason: OperatorSessionResetReason,
): boolean {
  return reason === "explicit_forget";
}

export function syndicationNoticeAfterReconciliation(
  current: string,
  deferred: number,
): string {
  if (deferred > 0) {
    return `${deferred} attached workflow${deferred === 1 ? "" : "s"} could not be reconciled yet. No item was marked published without complete evidence.`;
  }
  return /^\d+ attached workflows? could not be reconciled yet\. No item was marked published without complete evidence\.$/u
    .test(current)
    ? ""
    : current;
}

const LEAD_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sourceControlledTutorialSelections(
  value: unknown,
): SourceControlledTutorialSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: SourceControlledTutorialSelection[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const tutorialId = text(item.tutorialId);
    const title = text(item.title);
    const manifestStatus = text(item.manifestStatus);
    const sourcePath = text(item.sourcePath);
    const sourceSha256 = text(item.sourceSha256);
    const bodySha256 = text(item.bodySha256);
    if (
      !tutorialId
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tutorialId)
      || seen.has(tutorialId)
      || !title
      || title.length > 200
      || (manifestStatus !== "draft" && manifestStatus !== "approved_handoff")
      || sourcePath !== `docs/tutorials/${tutorialId}.md`
      || !sourceSha256
      || !/^[0-9a-f]{64}$/u.test(sourceSha256)
      || !bodySha256
      || !/^[0-9a-f]{64}$/u.test(bodySha256)
    ) continue;
    seen.add(tutorialId);
    selections.push({
      tutorialId,
      title,
      manifestStatus,
      sourcePath,
      sourceSha256,
      bodySha256,
    });
  }
  return selections;
}

export function tutorialApprovalEchoFromDraft(
  value: unknown,
): TutorialApprovalEcho | null {
  if (!isRecord(value) || !isRecord(value.tutorialHandoff)) return null;
  const handoff = value.tutorialHandoff;
  const tutorialId = text(handoff.tutorialId);
  const sourceSha256 = text(handoff.sourceSha256);
  const bodySha256 = text(handoff.bodySha256);
  const approval = isRecord(handoff.approval) ? handoff.approval : null;
  if (
    handoff.channel !== "substack"
    || handoff.status !== "requires_owner_approval"
    || handoff.modelRewriteAllowed !== false
    || !tutorialId
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tutorialId)
    || !sourceSha256
    || !/^[0-9a-f]{64}$/u.test(sourceSha256)
    || !bodySha256
    || !/^[0-9a-f]{64}$/u.test(bodySha256)
    || approval?.decision !== "pending"
    || approval?.tutorialId !== tutorialId
    || approval?.sourceSha256 !== sourceSha256
    || approval?.bodySha256 !== bodySha256
  ) return null;
  return { tutorialId, sourceSha256, bodySha256 };
}

function draftRequestsSubstack(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return false;
  return value.candidates.some(
    (candidate) => isRecord(candidate) && candidate.channel === "substack",
  );
}

function isBoundedTimestamp(value: string | null): value is string {
  return Boolean(
    value
    && value.length <= 40
    && Number.isFinite(Date.parse(value)),
  );
}

export function parseXIdentityVerification(
  value: unknown,
): XIdentityVerification | null {
  if (!isRecord(value)) return null;
  const authenticatedAccountId = text(value.authenticatedAccountId);
  const authenticatedUsername = text(value.authenticatedUsername);
  const observedAt = text(value.observedAt);
  if (
    !authenticatedAccountId
    || !/^\d{1,30}$/u.test(authenticatedAccountId)
    || !authenticatedUsername
    || !/^[A-Za-z0-9_]{1,15}$/u.test(authenticatedUsername)
    || !isBoundedTimestamp(observedAt)
  ) {
    return null;
  }
  return {
    authenticatedAccountId,
    authenticatedUsername,
    observedAt,
  };
}

const X_AUTOMATION_BOOLEAN_KEYS = [
  "ingestRequested",
  "autoReplyRequested",
  "autoResponseApproved",
  "commercialUseApproved",
  "complianceAttested",
  "complianceReady",
  "templateApprovalDigestValid",
  "hashSecretConfigured",
  "canonicalUsernameBound",
  "ingestReady",
  "autoReplyReady",
] as const;

const X_COMPLIANCE_RESULTS = new Set<XComplianceResult>([
  "healthy",
  "stale",
  "hold",
  "not_initialized",
  "account_not_found",
]);

const X_AUTOMATION_FIXED_BLOCKERS = new Set([
  "X mention ingestion requires recorded X commercial-use approval for this use case.",
  "X mention ingestion requires the operator compliance-monitor attestation.",
  "X mention ingestion requires a fresh healthy compliance checkpoint from the durable store.",
  "X mention ingestion requires the bound durable marketing database.",
  "X mention ingestion requires a valid global marketing configuration.",
  "X mention ingestion requires the bound X user-context identity.",
  "X mention ingestion requires the live marketing service.",
  "X mention ingestion requires X_EXPECTED_USERNAME to be exactly 0xzaps.",
  "Automatic X replies require X mention ingestion.",
  "Automatic X replies require a recorded X auto-response campaign approval attestation.",
  "Automatic X replies require approval of the exact current template registry digest.",
  "Automatic X replies require the automated-account label attestation.",
  "Automatic X replies require OPENZAPS_MARKETING_DAILY_X_REPLY_CAP to be at least 1.",
]);

function isSafeXAutomationBlocker(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500) return false;
  if (X_AUTOMATION_FIXED_BLOCKERS.has(value)) return true;
  return /^(?:OPENZAPS_X_MENTION_INGEST_ENABLED|OPENZAPS_X_AUTO_REPLY_ENABLED|OPENZAPS_X_AUTO_RESPONSE_APPROVED|OPENZAPS_X_COMMERCIAL_USE_APPROVED|OPENZAPS_X_COMPLIANCE_READY) must be exactly "true" or "false"\.$/u
    .test(value)
    || /^OPENZAPS_X_AUTO_REPLY_DAILY_CAP must be an integer from 0 to 5\.$/u
      .test(value)
    || /^OPENZAPS_X_MENTION_HASH_SECRET must be a server-only secret of at least 32 characters\.$/u
      .test(value)
    || /^X mention ingestion requires a fresh healthy compliance checkpoint; current state is (?:healthy|stale|hold|not_initialized|account_not_found)\.$/u
      .test(value);
}

function parseXComplianceHealth(value: unknown): XActivationStatus["complianceHealth"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const result = text(value.result);
  const checkedAt = value.checkedAt === null ? null : text(value.checkedAt);
  const validUntil = value.validUntil === null ? null : text(value.validUntil);
  const subjectCount = value.subjectCount;
  const nonPresentCount = value.nonPresentCount;
  if (
    !result
    || !X_COMPLIANCE_RESULTS.has(result as XComplianceResult)
    || (checkedAt !== null && !isBoundedTimestamp(checkedAt))
    || (validUntil !== null && !isBoundedTimestamp(validUntil))
    || typeof subjectCount !== "number"
    || !Number.isSafeInteger(subjectCount)
    || subjectCount < 0
    || subjectCount > 5_000
    || typeof nonPresentCount !== "number"
    || !Number.isSafeInteger(nonPresentCount)
    || nonPresentCount < 0
    || nonPresentCount > subjectCount
    || typeof value.hold !== "boolean"
  ) return undefined;
  return {
    result: result as XComplianceResult,
    checkedAt,
    validUntil,
    subjectCount,
    nonPresentCount,
    hold: value.hold,
  };
}

function xComplianceHealthIsCoherent(
  health: NonNullable<XActivationStatus["complianceHealth"]>,
): boolean {
  const timestampsPresent =
    health.checkedAt !== null && health.validUntil !== null;
  if ((health.checkedAt === null) !== (health.validUntil === null)) return false;
  if (
    health.result === "account_not_found"
    && (
      timestampsPresent
      || health.subjectCount !== 0
      || health.nonPresentCount !== 0
      || health.hold
    )
  ) return false;
  if (
    health.result === "healthy"
    && (
      !timestampsPresent
      || health.subjectCount < 1
      || health.nonPresentCount !== 0
      || health.hold
      || Date.parse(health.validUntil as string)
        <= Date.parse(health.checkedAt as string)
    )
  ) return false;
  if ((health.result === "hold") !== health.hold) return false;
  return true;
}

const X_BOOLEAN_CONFIGURATION_ERRORS = [
  {
    message:
      'OPENZAPS_X_MENTION_INGEST_ENABLED must be exactly "true" or "false".',
    key: "ingestRequested",
  },
  {
    message:
      'OPENZAPS_X_AUTO_REPLY_ENABLED must be exactly "true" or "false".',
    key: "autoReplyRequested",
  },
  {
    message:
      'OPENZAPS_X_AUTO_RESPONSE_APPROVED must be exactly "true" or "false".',
    key: "autoResponseApproved",
  },
  {
    message:
      'OPENZAPS_X_COMMERCIAL_USE_APPROVED must be exactly "true" or "false".',
    key: "commercialUseApproved",
  },
  {
    message:
      'OPENZAPS_X_COMPLIANCE_READY must be exactly "true" or "false".',
    key: "complianceAttested",
  },
] as const satisfies ReadonlyArray<{
  message: string;
  key: keyof XActivationStatus["automation"];
}>;
const X_CAP_CONFIGURATION_ERROR =
  "OPENZAPS_X_AUTO_REPLY_DAILY_CAP must be an integer from 0 to 5.";

function splitCoherentXConfigurationErrors(
  automation: XActivationStatus["automation"],
): { configurationErrors: string[]; conditionalBlockers: string[] } | null {
  const configurationErrors: string[] = [];
  const conditionalBlockers: string[] = [];
  let lastRank = -1;
  let conditionalStarted = false;
  for (const blocker of automation.blockers) {
    const booleanRank = X_BOOLEAN_CONFIGURATION_ERRORS.findIndex(
      ({ message }) => message === blocker,
    );
    const rank = blocker === X_CAP_CONFIGURATION_ERROR
      ? X_BOOLEAN_CONFIGURATION_ERRORS.length
      : booleanRank;
    if (rank < 0) {
      conditionalStarted = true;
      conditionalBlockers.push(blocker);
      continue;
    }
    if (conditionalStarted || rank <= lastRank) return null;
    if (rank === X_BOOLEAN_CONFIGURATION_ERRORS.length) {
      if (automation.dailyCap !== 0) return null;
    } else {
      const key = X_BOOLEAN_CONFIGURATION_ERRORS[rank]?.key;
      if (!key || automation[key] !== false) return null;
    }
    lastRank = rank;
    configurationErrors.push(blocker);
  }
  return { configurationErrors, conditionalBlockers };
}

function expectedXConditionalBlockers(input: {
  automation: XActivationStatus["automation"];
  operationalComplianceReady: boolean;
  complianceHealth: XActivationStatus["complianceHealth"];
  configEnabled: boolean;
  configDryRun: boolean;
  configurationValid: boolean;
  durableLedgerConfigured: boolean;
  xChannelConfigured: boolean;
  automatedLabelAttested: boolean;
  xReplyDailyCap: number;
}): string[] {
  const {
    automation,
    operationalComplianceReady,
    complianceHealth,
  } = input;
  const blockers: string[] = [];
  if (automation.ingestRequested && !automation.hashSecretConfigured) {
    blockers.push(
      "OPENZAPS_X_MENTION_HASH_SECRET must be a server-only secret of at least 32 characters.",
    );
  }
  if (automation.ingestRequested && !automation.canonicalUsernameBound) {
    blockers.push(
      "X mention ingestion requires X_EXPECTED_USERNAME to be exactly 0xzaps.",
    );
  }
  if (automation.ingestRequested && !automation.commercialUseApproved) {
    blockers.push(
      "X mention ingestion requires recorded X commercial-use approval for this use case.",
    );
  }
  if (automation.ingestRequested && !automation.complianceAttested) {
    blockers.push(
      "X mention ingestion requires the operator compliance-monitor attestation.",
    );
  }
  if (
    automation.ingestRequested
    && automation.complianceAttested
    && !operationalComplianceReady
  ) {
    blockers.push(
      complianceHealth
        ? "X mention ingestion requires a fresh healthy compliance checkpoint; current state is "
          + complianceHealth.result + "."
        : "X mention ingestion requires a fresh healthy compliance checkpoint from the durable store.",
    );
  }
  if (automation.ingestRequested && !input.durableLedgerConfigured) {
    blockers.push("X mention ingestion requires the bound durable marketing database.");
  }
  if (automation.ingestRequested && !input.configurationValid) {
    blockers.push("X mention ingestion requires a valid global marketing configuration.");
  }
  if (automation.ingestRequested && !input.xChannelConfigured) {
    blockers.push("X mention ingestion requires the bound X user-context identity.");
  }
  if (
    automation.ingestRequested
    && (!input.configEnabled || input.configDryRun)
  ) {
    blockers.push("X mention ingestion requires the live marketing service.");
  }
  if (automation.autoReplyRequested && !automation.ingestRequested) {
    blockers.push("Automatic X replies require X mention ingestion.");
  }
  if (automation.autoReplyRequested && !automation.autoResponseApproved) {
    blockers.push(
      "Automatic X replies require a recorded X auto-response campaign approval attestation.",
    );
  }
  if (
    automation.autoReplyRequested
    && !automation.templateApprovalDigestValid
  ) {
    blockers.push(
      "Automatic X replies require approval of the exact current template registry digest.",
    );
  }
  if (automation.autoResponseApproved && !input.automatedLabelAttested) {
    blockers.push(
      "Automatic X replies require the automated-account label attestation.",
    );
  }
  if (automation.autoReplyRequested && input.xReplyDailyCap < 1) {
    blockers.push(
      "Automatic X replies require OPENZAPS_MARKETING_DAILY_X_REPLY_CAP to be at least 1.",
    );
  }
  return blockers;
}

/**
 * Parse the private status response as activation evidence, not as authority.
 * Any missing, contradictory, or unexpectedly shaped field invalidates the
 * whole panel so partial server data can never be presented as X readiness.
 */
export function parseXActivationStatus(value: unknown): XActivationStatus | null {
  if (!isRecord(value) || value.service !== "OpenZaps marketing agent") return null;
  const activation = isRecord(value.xActivationEvidence)
    ? value.xActivationEvidence
    : null;
  const automation = isRecord(value.xMentionAutomation)
    ? value.xMentionAutomation
    : null;
  const config = isRecord(value.config) ? value.config : null;
  const dailyCaps = config && isRecord(config.dailyCaps) ? config.dailyCaps : null;
  const configReadiness = config && isRecord(config.readiness)
    ? config.readiness
    : null;
  const configChannels = configReadiness && isRecord(configReadiness.channels)
    ? configReadiness.channels
    : null;
  const policy = isRecord(value.policy) ? value.policy : null;
  const evaluatedAt = activation ? text(activation.evaluatedAt) : null;
  if (
    !activation
    || activation.schemaVersion !== 2
    || !automation
    || !config
    || !dailyCaps
    || !configReadiness
    || !configChannels
    || !policy
    || !isBoundedTimestamp(evaluatedAt)
    || activation.privacyUrl !== X_ACTIVATION_PRIVACY_URL
    || policy.xAutomaticReplyScope !== X_AUTOMATIC_REPLY_SCOPE
    || typeof config.enabled !== "boolean"
    || typeof config.dryRun !== "boolean"
    || typeof config.xAutomatedLabelConfirmed !== "boolean"
    || typeof configReadiness.configurationValid !== "boolean"
    || typeof configReadiness.durableLedgerConfigured !== "boolean"
    || typeof configChannels.x !== "boolean"
  ) return null;

  const expectedAccountIdentity = activation.expectedAccountIdentity;
  let expectedIdentity: XActivationStatus["expectedAccountIdentity"] = null;
  if (expectedAccountIdentity !== null) {
    if (!isRecord(expectedAccountIdentity)) return null;
    const accountId = text(expectedAccountIdentity.accountId);
    const username = text(expectedAccountIdentity.username);
    if (
      !accountId
      || !/^[1-9][0-9]{0,18}$/u.test(accountId)
      || !username
      || username !== "0xzaps"
    ) return null;
    expectedIdentity = { accountId, username };
  }

  if (!Array.isArray(activation.templates)) return null;
  if (activation.templates.length !== X_MENTION_APPROVAL_REGISTRY.length) return null;
  const templates: XActivationStatus["templates"] = [];
  for (const [index, expectedTemplate] of X_MENTION_APPROVAL_REGISTRY.entries()) {
    const candidate = activation.templates[index];
    if (!isRecord(candidate)) return null;
    const templateId = text(candidate.templateId);
    const body = text(candidate.body);
    const prompts = candidate.prompts;
    if (
      templateId !== expectedTemplate.templateId
      || body !== expectedTemplate.body
      || !Array.isArray(prompts)
      || prompts.length !== expectedTemplate.prompts.length
      || !prompts.every(
        (prompt, promptIndex) => prompt === expectedTemplate.prompts[promptIndex],
      )
    ) return null;
    templates.push({
      templateId: expectedTemplate.templateId,
      prompts: [...expectedTemplate.prompts],
      body: expectedTemplate.body,
    });
  }

  for (const key of X_AUTOMATION_BOOLEAN_KEYS) {
    if (typeof automation[key] !== "boolean") return null;
  }
  const complianceHealthName = text(automation.complianceHealth);
  const complianceValidUntil = automation.complianceValidUntil === null
    ? null
    : text(automation.complianceValidUntil);
  const templateRegistryDigest = text(automation.templateRegistryDigest);
  const dailyCap = automation.dailyCap;
  const xReplyDailyCap = dailyCaps.xReplies;
  if (
    !complianceHealthName
    || (complianceHealthName !== "unavailable"
      && !X_COMPLIANCE_RESULTS.has(complianceHealthName as XComplianceResult))
    || (complianceValidUntil !== null
      && !isBoundedTimestamp(complianceValidUntil))
    || !templateRegistryDigest
    || templateRegistryDigest !== X_MENTION_TEMPLATE_REGISTRY_DIGEST
    || typeof dailyCap !== "number"
    || !Number.isSafeInteger(dailyCap)
    || dailyCap < 0
    || dailyCap > 5
    || typeof xReplyDailyCap !== "number"
    || !Number.isSafeInteger(xReplyDailyCap)
    || xReplyDailyCap < 0
    || xReplyDailyCap > 100
    || dailyCap > xReplyDailyCap
    || !Array.isArray(automation.blockers)
    || automation.blockers.length > 32
    || !automation.blockers.every(isSafeXAutomationBlocker)
    || new Set(automation.blockers).size !== automation.blockers.length
  ) return null;

  const parsedAutomation: XActivationStatus["automation"] = {
    ingestRequested: automation.ingestRequested as boolean,
    autoReplyRequested: automation.autoReplyRequested as boolean,
    autoResponseApproved: automation.autoResponseApproved as boolean,
    commercialUseApproved: automation.commercialUseApproved as boolean,
    complianceAttested: automation.complianceAttested as boolean,
    complianceReady: automation.complianceReady as boolean,
    complianceHealth: complianceHealthName as XComplianceResult | "unavailable",
    complianceValidUntil,
    templateApprovalDigestValid: automation.templateApprovalDigestValid as boolean,
    templateRegistryDigest,
    hashSecretConfigured: automation.hashSecretConfigured as boolean,
    canonicalUsernameBound: automation.canonicalUsernameBound as boolean,
    ingestReady: automation.ingestReady as boolean,
    autoReplyReady: automation.autoReplyReady as boolean,
    dailyCap,
    blockers: [...automation.blockers] as string[],
  };
  const complianceHealth = parseXComplianceHealth(value.xComplianceHealth);
  if (complianceHealth === undefined) return null;
  if (
    complianceHealth === null
      ? complianceHealthName !== "unavailable"
        || complianceValidUntil !== null
      : !xComplianceHealthIsCoherent(complianceHealth)
        || complianceHealthName !== complianceHealth.result
        || complianceValidUntil !== complianceHealth.validUntil
  ) return null;

  const operationalComplianceReady = Boolean(
    complianceHealth
    && complianceHealth.result === "healthy"
    && complianceHealth.validUntil
    && Date.parse(complianceHealth.validUntil) > Date.parse(evaluatedAt)
  );
  if (
    parsedAutomation.complianceReady
      !== (parsedAutomation.complianceAttested && operationalComplianceReady)
    || (
      expectedIdentity !== null
      && !parsedAutomation.canonicalUsernameBound
    )
    || (
      configChannels.x
      && parsedAutomation.canonicalUsernameBound
      && expectedIdentity === null
    )
  ) return null;

  const splitBlockers = splitCoherentXConfigurationErrors(parsedAutomation);
  if (!splitBlockers) return null;
  const expectedConditionalBlockers = expectedXConditionalBlockers({
    automation: parsedAutomation,
    operationalComplianceReady,
    complianceHealth,
    configEnabled: config.enabled,
    configDryRun: config.dryRun,
    configurationValid: configReadiness.configurationValid,
    durableLedgerConfigured: configReadiness.durableLedgerConfigured,
    xChannelConfigured: configChannels.x,
    automatedLabelAttested: config.xAutomatedLabelConfirmed,
    xReplyDailyCap,
  });
  if (
    splitBlockers.conditionalBlockers.length
      !== expectedConditionalBlockers.length
    || !splitBlockers.conditionalBlockers.every(
      (blocker, index) => blocker === expectedConditionalBlockers[index],
    )
  ) return null;

  const expectedIngestReady =
    parsedAutomation.ingestRequested
    && splitBlockers.configurationErrors.length === 0
    && parsedAutomation.hashSecretConfigured
    && parsedAutomation.canonicalUsernameBound
    && parsedAutomation.commercialUseApproved
    && parsedAutomation.complianceAttested
    && operationalComplianceReady
    && configReadiness.configurationValid
    && config.enabled
    && !config.dryRun
    && configReadiness.durableLedgerConfigured
    && configChannels.x;
  const expectedAutoReplyReady =
    expectedIngestReady
    && parsedAutomation.autoReplyRequested
    && parsedAutomation.autoResponseApproved
    && parsedAutomation.templateApprovalDigestValid
    && config.xAutomatedLabelConfirmed
    && dailyCap > 0;
  if (
    parsedAutomation.ingestReady !== expectedIngestReady
    || parsedAutomation.autoReplyReady !== expectedAutoReplyReady
  ) return null;

  return {
    evaluatedAt,
    expectedAccountIdentity: expectedIdentity,
    privacyUrl: X_ACTIVATION_PRIVACY_URL,
    automaticReplyScope: X_AUTOMATIC_REPLY_SCOPE,
    templates,
    automation: parsedAutomation,
    complianceHealth,
    xReplyDailyCap,
    automatedLabelAttested: config.xAutomatedLabelConfirmed,
  };
}

export function xActivationApprovalPacket(status: XActivationStatus): string {
  const identity = status.expectedAccountIdentity
    ? `@${status.expectedAccountIdentity.username} (account ${status.expectedAccountIdentity.accountId})`
    : "UNAVAILABLE — expected account binding must be fixed before activation";
  const blockers = status.automation.blockers.length
    ? status.automation.blockers.map((blocker) => `- ${blocker}`).join("\n")
    : "- None reported by the server configuration snapshot.";
  const templates = status.templates
    .map((template, index) => [
      `${index + 1}. ${template.templateId}`,
      "Exact eligible prompts:",
      ...template.prompts.map((prompt) => `- ${prompt}`),
      "Exact response:",
      template.body,
    ].join("\n"))
    .join("\n\n");
  const automaticReplyCap = `${status.automation.dailyCap} deterministic automatic ${
    status.automation.dailyCap === 1 ? "reply" : "replies"
  }`;

  return [
    "DRAFT ONLY — DOES NOT ENABLE OR AUTHORIZE AUTOMATION",
    "OpenZaps X deterministic mention-response approval packet",
    "",
    `Snapshot evaluated at: ${status.evaluatedAt}`,
    `Expected account identity: ${identity}`,
    `Requested scope: ${status.automaticReplyScope}.`,
    "Hard boundaries: official mentions timeline only; exact prompt allowlist and reviewed replies only; first-run baseline; one reply per interaction; no search, scraping, DMs, freeform generation, media/external-link handling, or automatic replies to ambiguous or sensitive content.",
    `Caps: ${automaticReplyCap} per UTC day within the global ${status.xReplyDailyCap} X-reply cap. A cap never enables a gated lane.`,
    "Opt-out: an eligible author may reply @0xzaps stop. Suppression is persisted and no public confirmation is sent.",
    `Privacy notice: ${status.privacyUrl}`,
    `Template registry SHA-256: ${status.automation.templateRegistryDigest}`,
    "",
    "Exact deterministic prompt and response registry",
    templates,
    "",
    "Current server-reported blockers",
    blockers,
    "",
    "Owner and provider evidence required before activation",
    "[ ] X written approval for this exact brand auto-response campaign is retained.",
    "[ ] Commercial-use approval for official mention ingestion is retained.",
    "[ ] The exact prompt and response registry digest above is approved.",
    "[ ] The Automated label is visibly applied to @0xzaps and linked to the human-run managing account (external verification required).",
    "[ ] X API credits and account-spend availability are confirmed in the Developer Console (external verification required).",
    "[ ] A fresh healthy durable compliance checkpoint is present with no hold.",
    "",
    "This packet is evidence for owner/provider review only. Copying it does not change configuration, enable ingestion, enable replies, or contact X.",
  ].join("\n");
}

export async function writeXActivationApprovalPacket(
  packet: string,
  clipboard: ClipboardAccess | undefined,
): Promise<void> {
  if (!packet || packet.length > 10_000 || !clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await clipboard.writeText(packet);
}

export function xApprovalPacketCopyRequestIsCurrent(input: {
  requestedPacket: string;
  currentPacket: string;
  requestGeneration: number;
  currentRequestGeneration: number;
  active: boolean;
}): boolean {
  return input.active
    && input.requestedPacket === input.currentPacket
    && input.requestGeneration === input.currentRequestGeneration;
}

export function mountXApprovalPacketCopyLifecycle(state: {
  active: boolean;
  requestGeneration: number;
}): () => void {
  state.active = true;
  return () => {
    state.active = false;
    state.requestGeneration += 1;
  };
}

export async function writeCurrentXActivationApprovalPacket(input: {
  packet: string;
  clipboard: ClipboardAccess | undefined;
  requestGeneration: number;
  currentRequest: () => {
    packet: string;
    requestGeneration: number;
    active: boolean;
  };
}): Promise<"copied" | "stale"> {
  await writeXActivationApprovalPacket(input.packet, input.clipboard);
  const current = input.currentRequest();
  return xApprovalPacketCopyRequestIsCurrent({
    requestedPacket: input.packet,
    currentPacket: current.packet,
    requestGeneration: input.requestGeneration,
    currentRequestGeneration: current.requestGeneration,
    active: current.active,
  })
    ? "copied"
    : "stale";
}

function discordCommandCount(value: unknown, maximum: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum
    ? value
    : null;
}

function parseDiscordCommandCounts(
  value: unknown,
): DiscordCommandReadbackCounts | null {
  if (!isRecord(value)) return null;
  const desired = discordCommandCount(value.desired, 100);
  const remote = discordCommandCount(value.remote, 130);
  const create = discordCommandCount(value.create, 100);
  const update = discordCommandCount(value.update, 100);
  const deleteCount = discordCommandCount(value.delete, 130);
  if (
    desired === null
    || remote === null
    || create === null
    || update === null
    || deleteCount === null
  ) return null;
  return { desired, remote, create, update, delete: deleteCount };
}

function discordCommandCountsAreCoherent(
  counts: DiscordCommandReadbackCounts,
): boolean {
  return counts.create <= counts.desired
    && counts.update <= counts.desired - counts.create
    && counts.delete <= counts.remote
    && counts.remote === counts.desired - counts.create + counts.delete;
}

export function parseDiscordActivationVerification(
  value: unknown,
): DiscordActivationVerification | null {
  if (
    !isRecord(value)
    || value.service !== "OpenZaps Discord destination and command-manifest preflight"
    || value.writesPerformed !== false
    || !isRecord(value.destination)
    || value.destination.schemaVersion !== 1
    || value.destination.channel !== "discord"
    || (value.destination.transport !== "webhook"
      && value.destination.transport !== "bot")
    || value.destination.scope !== "configured_guild_channel"
    || value.destination.verified !== true
    || value.destination.mutationsPerformed !== false
    || !isRecord(value.commandReadback)
    || value.commandReadback.schemaVersion !== 1
    || value.commandReadback.scope !== "configured_application_guild"
    || value.commandReadback.guildPermissionVisibility !== "unchecked"
    || value.commandReadback.liveInvocationVerified !== false
    || value.commandReadback.writesPerformed !== false
  ) return null;

  const destination = {
    schemaVersion: 1 as const,
    channel: "discord" as const,
    transport: value.destination.transport as "webhook" | "bot",
    scope: "configured_guild_channel" as const,
    verified: true as const,
    mutationsPerformed: false as const,
  };
  const commandReadback = value.commandReadback;
  if (
    commandReadback.status === "not_configured"
    || commandReadback.status === "unavailable"
  ) {
    if (
      commandReadback.verified !== false
      || commandReadback.providerReadbackVerified !== false
      || commandReadback.managedCommandsInSync !== false
    ) return null;
    return {
      destination,
      commandReadback: {
        schemaVersion: 1,
        status: commandReadback.status,
        scope: "configured_application_guild",
        verified: false,
        providerReadbackVerified: false,
        managedCommandsInSync: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      },
      writesPerformed: false,
    };
  }
  if (
    commandReadback.status !== "in_sync"
    && commandReadback.status !== "drift"
  ) return null;
  const counts = parseDiscordCommandCounts(commandReadback.counts);
  const manifestSha256 = text(commandReadback.manifestSha256);
  const managedReadbackSha256 = text(commandReadback.managedReadbackSha256);
  if (
    commandReadback.verified !== true
    || commandReadback.providerReadbackVerified !== true
    || typeof commandReadback.managedCommandsInSync !== "boolean"
    || !counts
    || !discordCommandCountsAreCoherent(counts)
    || !manifestSha256
    || !/^[0-9a-f]{64}$/u.test(manifestSha256)
    || !managedReadbackSha256
    || !/^[0-9a-f]{64}$/u.test(managedReadbackSha256)
  ) return null;
  const hashesMatch = manifestSha256 === managedReadbackSha256;
  const expectedInSync = commandReadback.status === "in_sync";
  if (
    commandReadback.managedCommandsInSync !== expectedInSync
    || hashesMatch !== expectedInSync
    || (expectedInSync
      ? counts.create !== 0 || counts.update !== 0
      : counts.create === 0 && counts.update === 0)
  ) return null;
  return {
    destination,
    commandReadback: {
      schemaVersion: 1,
      status: commandReadback.status,
      scope: "configured_application_guild",
      verified: true,
      providerReadbackVerified: true,
      managedCommandsInSync: commandReadback.managedCommandsInSync,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      manifestSha256,
      managedReadbackSha256,
      counts,
      writesPerformed: false,
    },
    writesPerformed: false,
  };
}

export function discordActivationSummary(
  value: DiscordActivationVerification,
): string {
  const destination = `Discord ${value.destination.transport} destination verified.`;
  const readback = value.commandReadback;
  const boundary =
    "Guild command permissions were not checked, and the manifest readback does not prove a live signed invocation. Read-only check; no command was registered or changed.";
  if (readback.status === "not_configured") {
    return `${destination} Official guild-command readback is not configured because the server credential is missing or invalid. ${boundary}`;
  }
  if (readback.status === "unavailable") {
    return `${destination} Official guild-command readback is currently unavailable. ${boundary}`;
  }
  if (!("counts" in readback)) return `${destination} ${boundary}`;
  if (readback.status === "drift") {
    return `${destination} Official guild command-manifest projection found ${readback.counts.create} missing and ${readback.counts.update} drifted managed commands. ${boundary}`;
  }
  const unrelated = readback.counts.delete > 0
    ? ` ${readback.counts.delete} unrelated guild commands were left untouched.`
    : "";
  return `${destination} Official guild command-manifest projection matches all ${readback.counts.desired} source-controlled managed commands.${unrelated} ${boundary}`;
}

export function xIdentityRequestIsCurrent(input: {
  requestGeneration: number;
  currentRequestGeneration: number;
  sessionGeneration: number;
  currentSessionGeneration: number;
}): boolean {
  return input.requestGeneration === input.currentRequestGeneration
    && input.sessionGeneration === input.currentSessionGeneration;
}

export function discordPreflightRequestIsCurrent(input: {
  requestGeneration: number;
  currentRequestGeneration: number;
  sessionGeneration: number;
  currentSessionGeneration: number;
}): boolean {
  return input.requestGeneration === input.currentRequestGeneration
    && input.sessionGeneration === input.currentSessionGeneration;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readJson(response: Response): Promise<JsonRecord> {
  const body = await response.json().catch(() => null);
  return isRecord(body) ? body : {};
}

async function operatorRequest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<JsonRecord> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(
      text(body.error) ?? text(body.message) ?? `Request failed (${response.status}).`,
    ) as OperatorError;
    error.status = response.status;
    const responseRunId = runIdFrom(body);
    if (responseRunId && /^[^\s/\\]{1,200}$/u.test(responseRunId)) {
      error.runId = responseRunId;
    }
    const repairProof = text(body.repairProof);
    if (repairProof && /^[A-Za-z0-9_-]{43}$/u.test(repairProof)) {
      error.repairProof = repairProof;
    }
    throw error;
  }
  return body;
}

type ClipboardAccess = Partial<Pick<Clipboard, "write" | "writeText">>;

export async function writeSubstackClipboard(
  richText: SubstackRichText,
  clipboard: ClipboardAccess | undefined,
  ClipboardItemCtor: typeof ClipboardItem | undefined,
): Promise<"rich" | "plain"> {
  if (clipboard?.write && ClipboardItemCtor) {
    try {
      await clipboard.write([
        new ClipboardItemCtor({
          "text/html": new Blob([richText.html], { type: "text/html" }),
          "text/plain": new Blob([richText.plainText], {
            type: "text/plain",
          }),
        }),
      ]);
      return "rich";
    } catch {
      // Some browsers expose write() but reject HTML MIME clipboard items.
    }
  }
  if (clipboard?.writeText) {
    await clipboard.writeText(richText.plainText);
    return "plain";
  }
  throw new Error("Clipboard unavailable");
}

export async function writeSubstackManifestPatchClipboard(
  manifestPatch: string,
  clipboard: ClipboardAccess | undefined,
): Promise<void> {
  if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
  await clipboard.writeText(manifestPatch);
}

const CHANNEL_READINESS_COPY: Record<
  string,
  {
    label: string;
    supported: boolean;
    readyState: string;
    blockedState: string;
    readyDetail: string;
    blockedDetail: string;
  }
> = {
  x: {
    label: "X posts",
    supported: true,
    readyState: "configured",
    blockedState: "gated",
    readyDetail:
      "Credential, automated-label, and expected-account prerequisites are configured. Identity and write availability are rechecked before every post.",
    blockedDetail:
      "One or more credential, automated-label, or expected-account prerequisites are missing. No X write is admitted.",
  },
  discordBroadcast: {
    label: "Discord broadcasts",
    supported: true,
    readyState: "configured",
    blockedState: "gated",
    readyDetail:
      "Exact guild and channel bindings plus webhook or bot prerequisites are configured. The destination and provider response are rechecked before every post.",
    blockedDetail:
      "One or more Discord broadcast prerequisites are missing. No channel post is admitted.",
  },
  discordInteractions: {
    label: "Discord interactions",
    supported: true,
    readyState: "configured",
    blockedState: "not configured",
    readyDetail:
      "Signed-interaction verification and exact application and guild bindings are configured. This check does not prove a live command invocation.",
    blockedDetail:
      "Signed Discord interaction handling is not configured.",
  },
  directMessages: {
    label: "Direct messages",
    supported: false,
    readyState: "unsupported",
    blockedState: "unsupported",
    readyDetail:
      "Unsupported in this release; no direct-message adapter is deployed.",
    blockedDetail:
      "Unsupported in this release; no direct-message adapter is deployed.",
  },
  substackDirectPublish: {
    label: "Substack direct publish",
    supported: false,
    readyState: "unsupported",
    blockedState: "unsupported",
    readyDetail:
      "Unsupported in this release. Substack publishing stays an official-editor human handoff; no private or undocumented write API is used.",
    blockedDetail:
      "Unsupported in this release. Substack publishing stays an official-editor human handoff; no private or undocumented write API is used.",
  },
  substackManualHandoff: {
    label: "Substack editor handoff",
    supported: true,
    readyState: "manual",
    blockedState: "unavailable",
    readyDetail:
      "Human-only handoff to the official DeFi Tutorials editor is supported. Publication is verified separately through the public RSS feed.",
    blockedDetail:
      "The official-editor handoff is unavailable. Direct publishing remains unsupported.",
  },
  farcaster: {
    label: "Farcaster",
    supported: false,
    readyState: "not implemented",
    blockedState: "not implemented",
    readyDetail: "No reviewed Farcaster delivery adapter exists in this release.",
    blockedDetail: "No reviewed Farcaster delivery adapter exists in this release.",
  },
  github: {
    label: "GitHub",
    supported: false,
    readyState: "not implemented",
    blockedState: "not implemented",
    readyDetail: "No reviewed GitHub delivery adapter exists in this release.",
    blockedDetail: "No reviewed GitHub delivery adapter exists in this release.",
  },
};

function readinessValue(key: string, value: unknown): ReadinessRow {
  const channelCopy = CHANNEL_READINESS_COPY[key];
  if (channelCopy && typeof value === "boolean") {
    const ready = channelCopy.supported && value;
    return {
      key,
      label: channelCopy.label,
      ready,
      state: ready ? channelCopy.readyState : channelCopy.blockedState,
      detail: ready ? channelCopy.readyDetail : channelCopy.blockedDetail,
    };
  }
  if (typeof value === "boolean") {
    return {
      key,
      label: titleCase(key),
      ready: value,
      state: value ? "prerequisite met" : "gated",
      detail: value
        ? "The server-side prerequisite is satisfied. Provider availability is checked at action time."
        : "The prerequisite is not satisfied or the capability is gated.",
    };
  }
  if (typeof value === "string") {
    const state = value.toLowerCase();
    const ready = state === "ready" || state === "enabled" || state === "configured";
    return {
      key,
      label: titleCase(key),
      ready,
      state,
      detail: value,
    };
  }

  const entry = isRecord(value) ? value : {};
  const state = text(entry.status) ?? text(entry.state) ?? text(entry.mode);
  const ready = typeof entry.ready === "boolean"
    ? entry.ready
    : typeof entry.configured === "boolean"
      ? entry.configured
      : state === "ready" || state === "enabled" || state === "configured";

  return {
    key,
    label: text(entry.label) ?? text(entry.name) ?? titleCase(key),
    ready,
    state: state ?? (ready ? "ready" : "blocked"),
    detail:
      text(entry.detail)
      ?? text(entry.reason)
      ?? text(entry.message)
      ?? (ready
        ? "The server-side prerequisite is satisfied. Provider availability is checked at action time."
        : "The prerequisite is not satisfied or the capability is gated."),
  };
}

function modeReadiness(mode: string): ReadinessRow {
  const details: Record<string, string> = {
    disabled: "Marketing workflows are disabled. No draft or provider write is allowed.",
    dry_run:
      "Provider writes are disabled. Draft-generation readiness is reported separately.",
    review_only:
      "Automatic provider writes are off. Draft-generation readiness and human approval are reported separately.",
    live:
      "Bounded auto-publish is effective only for deterministic, source-reviewed campaigns. Durable admission, identity, destination, and provider response are still rechecked for every write.",
  };
  const knownMode = Object.prototype.hasOwnProperty.call(details, mode);
  return {
    key: "mode",
    label: "Runtime mode",
    ready: knownMode && mode !== "disabled",
    state: knownMode ? mode : "unknown",
    detail: details[mode] ?? `The server reported runtime mode “${mode}”.`,
  };
}

function dailyCapsReadiness(value: unknown): ReadinessRow | null {
  if (!isRecord(value)) return null;
  const labels: Record<string, string> = {
    xPosts: "X posts",
    xReplies: "X replies",
    discordPosts: "Discord posts",
    substackTutorials: "Substack editor handoffs",
    directMessages: "direct messages",
  };
  const entries = Object.entries(labels).flatMap(([key, label]) => {
    const cap = value[key];
    return typeof cap === "number" && Number.isInteger(cap) && cap >= 0
      ? [key === "directMessages"
        ? `${label} ${cap} (adapter unsupported)`
        : `${label} ${cap}`]
      : [];
  });
  if (entries.length !== Object.keys(labels).length) return null;
  return {
    key: "dailyCaps",
    label: "UTC daily caps",
    ready: true,
    state: "bounded",
    detail: `${entries.join(" · ")} per UTC day. Caps do not enable gated or unsupported adapters, and admission still checks durable usage before every write.`,
  };
}

export function readinessRows(status: JsonRecord | null): ReadinessRow[] {
  if (!status) return [];
  const root = isRecord(status.config) ? status.config : status;
  const readiness = isRecord(root.readiness) ? root.readiness : null;
  const source = root.channels ?? readiness?.channels ?? root.checks;
  const rows: ReadinessRow[] = [];

  const mode = text(root.mode);
  if (mode) rows.push(modeReadiness(mode));

  if (readiness && typeof readiness.configurationValid === "boolean") {
    rows.push(readinessValue("configuration", {
      label: "Configuration validation",
      ready: readiness.configurationValid,
      detail: readiness.configurationValid
        ? "Configured values passed local validation. This check does not test provider or database availability."
        : "One or more configured values are invalid; affected actions fail closed.",
    }));
  }
  if (readiness && typeof readiness.canDraft === "boolean") {
    const blockers = Array.isArray(readiness.blockers)
      ? readiness.blockers.filter((blocker): blocker is string => typeof blocker === "string")
      : [];
    rows.push(readinessValue("drafting", {
      label: "Draft generation",
      ready: readiness.canDraft,
      detail: readiness.canDraft
        ? "Server-side prerequisites for source-backed draft generation are satisfied. No provider write is implied."
        : blockers.length
          ? `Draft generation is gated. ${blockers.join(" ")}`
          : "Draft generation is gated.",
    }));
  }
  if (readiness && typeof readiness.durableLedgerConfigured === "boolean") {
    rows.push(readinessValue("durableLedger", {
      label: "Durable delivery ledger",
      ready: readiness.durableLedgerConfigured,
      state: readiness.durableLedgerConfigured ? "configured" : "gated",
      detail: readiness.durableLedgerConfigured
        ? "Exact-project environment prerequisites are configured. Schema and database availability are rechecked by each ledger operation."
        : "Durable cross-run ledger prerequisites are not satisfied; non-dry-run drafting and auto-publish fail closed.",
    }));
  }
  if (
    readiness
    && typeof readiness.autoPublishReady === "boolean"
    && typeof root.autoPublishRequested === "boolean"
    && typeof root.autoPublish === "boolean"
  ) {
    const requested = root.autoPublishRequested;
    const effective = root.autoPublish;
    const eligible = readiness.autoPublishReady;
    rows.push(readinessValue("autoPublish", {
      label: "Bounded auto-publish",
      ready: effective || (!requested && eligible),
      state: effective
        ? "effective"
        : requested
          ? "gated"
          : eligible
            ? "ready, not requested"
            : "off",
      detail: effective
        ? "Effective only for deterministic, source-reviewed scheduled campaigns. Every write still requires durable admission and fresh provider identity and destination checks."
        : requested
          ? "Requested, but one or more safety prerequisites are not satisfied. No automatic provider write is allowed."
          : eligible
            ? "Safety prerequisites are configured, but auto-publish was not requested. Outbound delivery remains human-reviewed."
            : "Auto-publish is off. Outbound delivery remains human-reviewed.",
    }));
  }
  if (typeof root.xAiReplyApproved === "boolean") {
    rows.push(readinessValue("xReplyPolicy", {
      label: "X reply policy",
      ready: root.xAiReplyApproved,
      state: root.xAiReplyApproved ? "platform gate enabled" : "gated",
      detail: root.xAiReplyApproved
        ? "The X AI-reply and automated-label configuration gates are enabled. Each reply still requires an operator-selected, API-verified interaction and per-interaction human approval."
        : "AI-authored X replies remain gated. Per-interaction human approval is still required for every reply.",
    }));
  }
  const caps = dailyCapsReadiness(root.dailyCaps);
  if (caps) rows.push(caps);

  if (Array.isArray(source)) {
    return [...rows, ...source.map((value, index) => {
      const entry = isRecord(value) ? value : {};
      const key =
        text(entry.channel)
        ?? text(entry.key)
        ?? text(entry.name)
        ?? `check-${index + 1}`;
      return readinessValue(key, value);
    })];
  }
  if (isRecord(source)) {
    return [...rows, ...Object.entries(source).map(([key, value]) => readinessValue(key, value))];
  }
  return rows;
}

function xActivationGateRow(
  key: string,
  label: string,
  ready: boolean,
  readyState: string,
  blockedState: string,
  detail: string,
): ReadinessRow {
  return {
    key,
    label,
    ready,
    state: ready ? readyState : blockedState,
    detail,
  };
}

export function xActivationRows(status: XActivationStatus): ReadinessRow[] {
  const automation = status.automation;
  const health = status.complianceHealth;
  const identity = status.expectedAccountIdentity;
  const automaticReplyCap = `${automation.dailyCap} automatic ${
    automation.dailyCap === 1 ? "reply" : "replies"
  }`;
  return [
    xActivationGateRow(
      "xExpectedIdentity",
      "Expected X identity",
      identity !== null,
      "bound",
      "gated",
      identity
        ? `Server expects @${identity.username}, account ${identity.accountId}. A live official-API identity check remains separate.`
        : "The public expected account id and username are absent or invalid. Ingestion and replies must stay off.",
    ),
    xActivationGateRow(
      "xMentionIngestRequested",
      "Mention ingestion requested",
      automation.ingestRequested,
      "requested",
      "off",
      automation.ingestRequested
        ? "The server flag requests official mentions-timeline ingestion; all remaining admission gates still apply."
        : "Official mentions-timeline ingestion was not requested.",
    ),
    xActivationGateRow(
      "xAutoReplyRequested",
      "Automatic replies requested",
      automation.autoReplyRequested,
      "requested",
      "off",
      automation.autoReplyRequested
        ? "The deterministic reply lane was requested; this does not establish provider approval or external readiness."
        : "The deterministic automatic-reply lane was not requested.",
    ),
    xActivationGateRow(
      "xAutoResponseApproved",
      "Campaign approval attestation",
      automation.autoResponseApproved,
      "recorded",
      "missing",
      automation.autoResponseApproved
        ? "A server-side attestation says written approval was recorded. The operator must retain the external approval evidence."
        : "No server-side attestation of X approval for this exact brand auto-response campaign is recorded.",
    ),
    xActivationGateRow(
      "xCommercialUseApproved",
      "Commercial-use attestation",
      automation.commercialUseApproved,
      "recorded",
      "missing",
      automation.commercialUseApproved
        ? "A server-side commercial-use attestation is recorded; its external approval evidence must still be retained."
        : "Official mention ingestion is gated without the recorded commercial-use attestation.",
    ),
    xActivationGateRow(
      "xComplianceAttested",
      "Compliance monitor attestation",
      automation.complianceAttested,
      "recorded",
      "missing",
      automation.complianceAttested
        ? "The compliance-monitor prerequisite flag is recorded. Durable health and freshness are checked separately."
        : "The compliance-monitor prerequisite flag is not recorded.",
    ),
    xActivationGateRow(
      "xComplianceReady",
      "Operational compliance gate",
      automation.complianceReady,
      "ready",
      "gated",
      automation.complianceReady
        ? "The attestation and current durable checkpoint jointly satisfy the operational gate for this snapshot."
        : "The attestation and durable checkpoint do not jointly satisfy the operational compliance gate.",
    ),
    xActivationGateRow(
      "xAutomationComplianceView",
      "Automation compliance view",
      automation.complianceHealth === "healthy"
        && automation.complianceValidUntil !== null,
      automation.complianceHealth,
      automation.complianceHealth,
      `The automation evaluator reports ${automation.complianceHealth}; valid until ${automation.complianceValidUntil ?? "unavailable"}.`,
    ),
    xActivationGateRow(
      "xHashSecretConfigured",
      "Content-hash prerequisite",
      automation.hashSecretConfigured,
      "configured",
      "gated",
      automation.hashSecretConfigured
        ? "A bounded server-only content-hash secret is configured. Its value is never returned or rendered."
        : "The server-only content-hash prerequisite is absent or invalid; no secret value is exposed.",
    ),
    xActivationGateRow(
      "xCanonicalUsernameBound",
      "Canonical username binding",
      automation.canonicalUsernameBound,
      "@0xzaps bound",
      "gated",
      automation.canonicalUsernameBound
        ? "The deterministic mention lane is bound to the exact canonical username 0xzaps."
        : "The exact canonical username 0xzaps is not bound. Ingestion and replies must stay off.",
    ),
    xActivationGateRow(
      "xTemplateDigestApproved",
      "Exact registry digest approval",
      automation.templateApprovalDigestValid,
      "matched",
      "gated",
      automation.templateApprovalDigestValid
        ? `The recorded approval matches the exact prompt and response registry SHA-256 ${automation.templateRegistryDigest}.`
        : `No approval matches the current prompt and response registry SHA-256 ${automation.templateRegistryDigest}.`,
    ),
    xActivationGateRow(
      "xMentionIngestReady",
      "Mention ingestion gate",
      automation.ingestReady,
      "locally ready",
      "gated",
      automation.ingestReady
        ? "All server-side ingestion prerequisites passed for this snapshot. This is not a provider write or external verification."
        : "At least one server-side ingestion prerequisite is unsatisfied. No ingestion-readiness claim is made.",
    ),
    xActivationGateRow(
      "xAutoReplyReady",
      "Automatic reply gate",
      automation.autoReplyReady,
      "locally ready",
      "gated",
      automation.autoReplyReady
        ? "All server-side deterministic-reply prerequisites passed for this snapshot. External label visibility and API credits remain unverified."
        : "At least one deterministic-reply prerequisite is unsatisfied. No automatic-reply readiness claim is made.",
    ),
    xActivationGateRow(
      "xAutomaticReplyDailyCap",
      "Deterministic reply cap",
      automation.dailyCap > 0,
      "bounded",
      "zero",
      `${automaticReplyCap} per UTC day. This effective cap cannot exceed the global X-reply cap and never enables a gated lane.`,
    ),
    xActivationGateRow(
      "xGlobalReplyDailyCap",
      "Global X reply cap",
      status.xReplyDailyCap > 0,
      "bounded",
      "zero",
      `${status.xReplyDailyCap} total X replies per UTC day across admitted reply lanes.`,
    ),
    xActivationGateRow(
      "xAutomatedLabelAttestation",
      "Automated-label config attestation",
      status.automatedLabelAttested,
      "recorded",
      "missing",
      status.automatedLabelAttested
        ? "The configuration attestation is recorded. It does not prove that the label is currently visible or manager-linked on X."
        : "The configuration attestation is missing; X publishing and automatic replies stay gated.",
    ),
    xActivationGateRow(
      "xComplianceResult",
      "Durable compliance result",
      health?.result === "healthy",
      "healthy",
      health?.result ?? "unavailable",
      health
        ? `The durable checkpoint result is ${health.result}.`
        : "No bounded durable compliance-health response was available.",
    ),
    xActivationGateRow(
      "xComplianceCheckedAt",
      "Compliance checked at",
      health?.checkedAt !== null && health?.checkedAt !== undefined,
      "recorded",
      "unavailable",
      health?.checkedAt
        ? `The durable checkpoint was recorded at ${health.checkedAt}.`
        : "The durable checkpoint has no bounded checked-at timestamp.",
    ),
    xActivationGateRow(
      "xComplianceValidUntil",
      "Compliance valid until",
      health?.validUntil !== null && health?.validUntil !== undefined,
      "recorded",
      "unavailable",
      health?.validUntil
        ? `The durable checkpoint reports validity until ${health.validUntil}; action-time freshness is still required.`
        : "The durable checkpoint has no bounded validity deadline.",
    ),
    xActivationGateRow(
      "xComplianceCoverage",
      "Compliance subject coverage",
      health !== null && health.nonPresentCount === 0,
      "complete",
      health ? "action required" : "unavailable",
      health
        ? `${health.subjectCount} subjects checked; ${health.nonPresentCount} were not present.`
        : "Subject and non-present counts are unavailable.",
    ),
    xActivationGateRow(
      "xComplianceHold",
      "Compliance hold",
      health !== null && !health.hold,
      "clear",
      health?.hold ? "hold" : "unavailable",
      health
        ? health.hold
          ? "A durable compliance hold is active. Outbound activity must remain fenced."
          : "The bounded durable health response reports no compliance hold."
        : "Hold state is unavailable, so the panel fails closed.",
    ),
    xActivationGateRow(
      "xAutomatedLabelExternal",
      "Automated label visibility",
      false,
      "verified",
      "external verification required",
      "This endpoint cannot prove that X currently displays the Automated label or links it to the human-run managing account. Verify on the canonical X profile.",
    ),
    xActivationGateRow(
      "xApiCreditsExternal",
      "X API credits",
      false,
      "verified",
      "external verification required",
      "This endpoint cannot inspect Developer Console credits or account-spend availability. Confirm them externally before any controlled test.",
    ),
  ];
}

export function operatorLeads(body: JsonRecord): OperatorLead[] {
  if (!Array.isArray(body.leads) || body.leads.length > 100) return [];

  return body.leads.flatMap((value): OperatorLead[] => {
    if (!isRecord(value)) return [];
    const id = text(value.id);
    const persona = text(value.persona);
    const name = text(value.name);
    const email = text(value.email);
    const emailVerified = value.emailVerified;
    const workflow = text(value.workflow);
    const trigger = text(value.trigger);
    const guardrails = text(value.guardrails);
    const timeline = text(value.timeline);
    const status = text(value.status);
    const createdAt = text(value.createdAt);
    const updatedAt = text(value.updatedAt);
    const expiresAt = text(value.expiresAt);
    const score = value.qualificationScore;
    if (
      !id
      || !persona
      || !name
      || !email
      || typeof emailVerified !== "boolean"
      || !workflow
      || !trigger
      || !guardrails
      || !timeline
      || !status
      || !["new", "contacted", "qualified", "closed"].includes(status)
      || !createdAt
      || !updatedAt
      || !expiresAt
      || typeof score !== "number"
      || !Number.isInteger(score)
      || score < 0
      || score > 5
    ) {
      return [];
    }

    return [{
      id,
      persona,
      name,
      email,
      emailVerified,
      project: text(value.project),
      projectUrl: text(value.projectUrl),
      workflow,
      protocolsAssets: text(value.protocolsAssets),
      trigger,
      guardrails,
      timeline,
      attribution: isRecord(value.attribution) ? value.attribution : {},
      qualificationScore: score,
      status: status as LeadStatus,
      createdAt,
      updatedAt,
      expiresAt,
    }];
  });
}

function boundedCount(value: unknown, maximum = 100): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum
    ? value
    : null;
}

function leadScorecardWindow(
  value: unknown,
  maximum: number,
): LeadScorecardWindow | null {
  if (!isRecord(value)) return null;
  const accepted = boundedCount(value.accepted, maximum);
  const score3Plus = boundedCount(value.score3Plus, maximum);
  const progressed = boundedCount(value.progressed, maximum);
  const currentQualified = boundedCount(value.currentQualified, maximum);
  if (
    accepted === null
    || score3Plus === null
    || progressed === null
    || currentQualified === null
    || score3Plus > accepted
    || progressed > accepted
    || currentQualified > progressed
  ) return null;
  return { accepted, score3Plus, progressed, currentQualified };
}

function leadScorecardAttribution(
  value: unknown,
  maximum: number,
): LeadScorecardAttribution | null {
  if (!isRecord(value)) return null;
  const source = text(value.source);
  const campaign = text(value.campaign);
  const content = text(value.content);
  const accepted = boundedCount(value.accepted, maximum);
  const score3Plus = boundedCount(value.score3Plus, maximum);
  const currentQualified = boundedCount(value.currentQualified, maximum);
  if (
    !source
    || !campaign
    || !content
    || !leadScorecardAttributionDimensionIsValid("source", source)
    || !leadScorecardAttributionDimensionIsValid("campaign", campaign)
    || !leadScorecardAttributionDimensionIsValid("content", content)
    || accepted === null
    || score3Plus === null
    || currentQualified === null
    || accepted === 0
    || score3Plus > accepted
    || currentQualified > accepted
  ) return null;
  return {
    source,
    campaign,
    content,
    accepted,
    score3Plus,
    currentQualified,
  };
}

export function parseLeadScorecard(body: JsonRecord): LeadScorecard | null {
  if (!isRecord(body.scorecard)) return null;
  const value = body.scorecard;
  if (
    value.schemaVersion !== 1
    || !isBoundedTimestamp(text(value.generatedAt))
    || !isRecord(value.scope)
    || value.scope.basis !== "accepted_requests_onward"
    || value.scope.population !== "nonexpired_stored_requests"
    || value.scope.selection !== "qualification_score_desc_then_created_at_desc"
    || value.scope.maxRows !== 100
  ) return null;
  const returnedRows = boundedCount(value.scope.returnedRows);
  if (
    returnedRows === null
    || value.scope.truncated !== (returnedRows === 100)
    || value.scope.complete !== (returnedRows < 100)
    || !isRecord(value.windows)
  ) return null;
  const days7 = leadScorecardWindow(value.windows.days7, returnedRows);
  const days30 = leadScorecardWindow(value.windows.days30, returnedRows);
  const overdueReviewCount = boundedCount(
    value.overdueReviewCount,
    returnedRows,
  );
  if (
    !days7
    || !days30
    || days7.accepted > days30.accepted
    || days7.score3Plus > days30.score3Plus
    || days7.progressed > days30.progressed
    || days7.currentQualified > days30.currentQualified
    || overdueReviewCount === null
    || !isRecord(value.stages)
  ) return null;
  const stages = value.stages;
  const stageEntries = ["new", "contacted", "qualified", "closed"] as const;
  const stageCounts = stageEntries.map((status) =>
    boundedCount(stages[status], returnedRows));
  if (
    stageCounts.some((count) => count === null)
    || stageCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
      !== returnedRows
    || overdueReviewCount > (stageCounts[0] ?? 0)
    || !Array.isArray(value.attribution)
    || value.attribution.length > 12
  ) return null;
  const [newCount, contacted, qualified, closed] = stageCounts as [
    number,
    number,
    number,
    number,
  ];
  if (
    days30.currentQualified > qualified
    || days30.progressed > contacted + qualified + closed
  ) return null;
  const attribution = value.attribution.map((row) =>
    leadScorecardAttribution(row, days30.accepted));
  if (attribution.some((row) => row === null)) return null;
  const parsedAttribution = attribution as LeadScorecardAttribution[];
  const remainingRows = parsedAttribution.filter((row) =>
    row.source === "remaining"
    || row.campaign === "remaining"
    || row.content === "remaining");
  const attributionKeys = new Set(
    parsedAttribution.map((row) =>
      JSON.stringify([row.source, row.campaign, row.content])),
  );
  const attributionTotals = parsedAttribution.reduce(
    (totals, row) => ({
      accepted: totals.accepted + row.accepted,
      score3Plus: totals.score3Plus + row.score3Plus,
      currentQualified:
        totals.currentQualified + row.currentQualified,
    }),
    { accepted: 0, score3Plus: 0, currentQualified: 0 },
  );
  if (
    attributionKeys.size !== parsedAttribution.length
    || remainingRows.some((row) =>
      row.source !== "remaining"
      || row.campaign !== "remaining"
      || row.content !== "remaining")
    || remainingRows.length > 1
    || (remainingRows.length === 1
      && (
        parsedAttribution.length !== 12
        || days30.accepted < 13
        || remainingRows[0].accepted < 2
        || parsedAttribution.at(-1) !== remainingRows[0]
      ))
    || attributionTotals.accepted !== days30.accepted
    || attributionTotals.score3Plus !== days30.score3Plus
    || attributionTotals.currentQualified !== days30.currentQualified
  ) return null;
  return {
    schemaVersion: 1,
    generatedAt: text(value.generatedAt)!,
    scope: {
      basis: "accepted_requests_onward",
      population: "nonexpired_stored_requests",
      selection: "qualification_score_desc_then_created_at_desc",
      maxRows: 100,
      returnedRows,
      truncated: returnedRows === 100,
      complete: returnedRows < 100,
    },
    windows: { days7, days30 },
    overdueReviewCount,
    stages: { new: newCount, contacted, qualified, closed },
    attribution: parsedAttribution,
  };
}

export function operatorSyndicationItems(
  body: JsonRecord,
): OperatorSyndicationItem[] {
  if (!Array.isArray(body.items) || body.items.length > 20) return [];
  const sources = new Set<SyndicationSource>(["openzaps", "defitutorials"]);
  const classifications = new Set<SyndicationClassification>([
    "reviewable",
    "needs_classification",
  ]);
  const statuses = new Set<SyndicationStatus>([
    "baseline",
    "pending",
    "drafting",
    "awaiting_approval",
    "published",
    "skipped",
    "failed",
  ]);

  return body.items.flatMap((value): OperatorSyndicationItem[] => {
    if (!isRecord(value)) return [];
    const itemId = text(value.itemId);
    const source = text(value.source);
    const title = text(value.title);
    const canonicalUrl = text(value.canonicalUrl);
    const publishedAt = value.publishedAt === null
      ? null
      : text(value.publishedAt);
    const classification = text(value.classification);
    const status = text(value.status);
    const campaignSlug = text(value.campaignSlug);
    const workflowRunId = value.workflowRunId === null
      ? null
      : text(value.workflowRunId);
    const discoveredAt = text(value.discoveredAt);
    const updatedAt = text(value.updatedAt);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(canonicalUrl ?? "");
    } catch {
      return [];
    }
    const allowedUrl =
      parsedUrl.protocol === "https:"
      && !parsedUrl.username
      && !parsedUrl.password
      && !parsedUrl.port
      && !parsedUrl.search
      && !parsedUrl.hash
      && (
        (
          source === "openzaps"
          && parsedUrl.hostname === "www.0xzaps.com"
        )
        || (
          source === "defitutorials"
          && parsedUrl.hostname === "defitutorials.substack.com"
          && /^\/p\/[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?\/?$/u.test(
            parsedUrl.pathname,
          )
        )
      );
    if (
      !itemId
      || !/^[0-9a-f]{64}$/u.test(itemId)
      || !source
      || !sources.has(source as SyndicationSource)
      || !title
      || Array.from(title).length > 200
      || !canonicalUrl
      || !allowedUrl
      || (value.publishedAt !== null && !publishedAt)
      || (publishedAt !== null && !isBoundedTimestamp(publishedAt))
      || !classification
      || !classifications.has(classification as SyndicationClassification)
      || !status
      || !statuses.has(status as SyndicationStatus)
      || !campaignSlug
      || !/^[a-z0-9][a-z0-9-]{0,95}$/u.test(campaignSlug)
      || (value.workflowRunId !== null && !workflowRunId)
      || (workflowRunId !== null && !/^[^\s/\\]{1,200}$/u.test(workflowRunId))
      || (["baseline", "pending", "skipped"].includes(status) && workflowRunId !== null)
      || (["awaiting_approval", "published"].includes(status) && workflowRunId === null)
      || !discoveredAt
      || !isBoundedTimestamp(discoveredAt)
      || !updatedAt
      || !isBoundedTimestamp(updatedAt)
    ) return [];

    return [{
      itemId,
      source: source as SyndicationSource,
      title,
      canonicalUrl,
      publishedAt,
      classification: classification as SyndicationClassification,
      status: status as SyndicationStatus,
      campaignSlug,
      workflowRunId,
      discoveredAt,
      updatedAt,
    }];
  });
}

export function leadReplyHref(email: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
    "Your OpenZaps Zap request",
  )}`;
}

export function leadDeleteTriggerId(id: string): string {
  return `lead-delete-trigger-${encodeURIComponent(id)}`;
}

export function syndicationSkipTriggerId(id: string): string {
  return `syndication-skip-trigger-${encodeURIComponent(id)}`;
}

export function parseSyndicationRepairPair(
  value: string,
): SyndicationRepairPair | null {
  if (!value || value.length > 400) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 3) return null;
    const itemId = text(parsed.itemId);
    const runId = text(parsed.runId);
    const repairProof = text(parsed.repairProof);
    if (
      !itemId
      || !/^[0-9a-f]{64}$/u.test(itemId)
      || !runId
      || !/^[^\s/\\]{1,200}$/u.test(runId)
      || !repairProof
      || !/^[A-Za-z0-9_-]{43}$/u.test(repairProof)
    ) return null;
    return { itemId, runId, repairProof };
  } catch {
    return null;
  }
}

export function syndicationDeferredCount(body: JsonRecord): number {
  const reconciliation = isRecord(body.reconciliation)
    ? body.reconciliation
    : null;
  const deferred = reconciliation?.deferred;
  return typeof deferred === "number"
    && Number.isSafeInteger(deferred)
    && deferred >= 0
    && deferred <= 20
    ? deferred
    : 0;
}

export function syndicationRepairMatchesItem(
  item: OperatorSyndicationItem,
  repair: SyndicationRepairPair | null,
): boolean {
  return Boolean(
    repair
    && item.status === "drafting"
    && item.workflowRunId === null
    && item.itemId === repair.itemId,
  );
}

export function syndicationItemCanDraft(
  item: OperatorSyndicationItem,
): boolean {
  if (item.classification !== "reviewable" || item.status !== "pending") {
    return false;
  }
  const url = new URL(item.canonicalUrl);
  url.searchParams.set("utm_source", "x");
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", item.campaignSlug);
  url.searchParams.set("utm_content", "feed_update");
  return Array.from(url.toString()).length <= 200;
}

export function pollRetryDelay(failureCount: number): number {
  const exponent = Math.max(0, Math.floor(failureCount) - 1);
  return Math.min(POLL_INTERVAL_MS * 2 ** exponent, POLL_MAX_INTERVAL_MS);
}

export function shouldRetryPoll(status?: number): boolean {
  return (
    status === undefined
    || status === 408
    || status === 429
    || (status >= 500 && status <= 599)
  );
}

export function leadOperationIsCurrent(input: {
  expectedSessionGeneration: number;
  expectedActionGeneration: number;
  currentSessionGeneration: number;
  currentActionGeneration: number;
}): boolean {
  return (
    input.expectedSessionGeneration === input.currentSessionGeneration &&
    input.expectedActionGeneration === input.currentActionGeneration
  );
}

function leadDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Unknown time"
    : LEAD_DATE_FORMATTER.format(parsed);
}

function nestedRun(body: JsonRecord): JsonRecord {
  return isRecord(body.run) ? body.run : body;
}

function runIdFrom(body: JsonRecord): string | null {
  const run = nestedRun(body);
  return text(body.runId) ?? text(body.id) ?? text(run.runId) ?? text(run.id);
}

function runStatus(run: JsonRecord | null): string {
  if (!run) return "starting";
  const nested = nestedRun(run);
  return text(nested.status) ?? text(run.status) ?? "running";
}

function draftFrom(run: JsonRecord | null): unknown {
  if (!run) return null;
  const nested = nestedRun(run);
  return nested.draft ?? run.draft ?? null;
}

function resultFrom(run: JsonRecord | null): unknown {
  if (!run) return null;
  const nested = nestedRun(run);
  return nested.result ?? run.result ?? null;
}

export function hasSubstackEditorHandoff(
  result: unknown,
  candidateId?: string,
): boolean {
  if (!isRecord(result) || !Array.isArray(result.deliveries)) return false;
  return result.deliveries.some(
    (delivery) =>
      isRecord(delivery)
      && text(delivery.channel) === "substack"
      && text(delivery.status) === "requires_human_publish"
      && Boolean(text(delivery.candidateId))
      && (!candidateId || text(delivery.candidateId) === candidateId)
      && text(delivery.editorUrl) ===
        "https://defitutorials.substack.com/publish/post",
  );
}

export function parseSubstackVerification(
  body: JsonRecord,
  expected: {
    runId: string;
    candidateId: string;
    canonicalUrl: string;
    tutorialId: string;
    approvedTitle: string;
    sourcePath: string;
  },
): SubstackVerification | null {
  const runId = text(body.runId);
  const candidateId = text(body.candidateId);
  const status = text(body.status);
  const canonicalUrl = text(body.canonicalUrl);
  const approvedTitle = text(body.approvedTitle);
  const feedUrl = text(body.feedUrl);
  const checkedAt = text(body.checkedAt);
  const publishedAt = text(body.publishedAt);
  const hasPublishedAt = body.publishedAt !== undefined && body.publishedAt !== null;
  if (
    runId !== expected.runId
    || candidateId !== expected.candidateId
    || !status
    || !["rss_confirmed", "not_found", "title_mismatch"].includes(status)
    || !canonicalUrl
    || canonicalUrl !== expected.canonicalUrl
    || !approvedTitle
    || feedUrl !== "https://defitutorials.substack.com/feed"
    || !checkedAt
    || !Number.isFinite(Date.parse(checkedAt))
    || (hasPublishedAt && (!publishedAt || !Number.isFinite(Date.parse(publishedAt))))
  ) return null;

  const base = {
    runId,
    candidateId,
    canonicalUrl,
    approvedTitle,
    feedUrl,
    checkedAt,
    ...(publishedAt ? { publishedAt } : {}),
  };

  if (status !== "rss_confirmed") {
    if (
      body.persisted !== false
      || body.receiptResult !== undefined
      || body.manifestEntry !== undefined
      || body.manifestPatch !== undefined
    ) return null;
    return {
      ...base,
      status: status as "not_found" | "title_mismatch",
      persisted: false,
    };
  }

  const receiptResult = text(body.receiptResult);
  const rawManifestEntry = isRecord(body.manifestEntry)
    ? body.manifestEntry
    : null;
  const manifestId = text(rawManifestEntry?.id);
  const manifestTitle = text(rawManifestEntry?.title);
  const manifestSourcePath = text(rawManifestEntry?.sourcePath);
  const manifestStatus = text(rawManifestEntry?.status);
  const manifestCanonicalUrl = text(rawManifestEntry?.canonicalUrl);
  const manifestPublishedAt = text(rawManifestEntry?.publishedAt);
  const manifestPatch = typeof body.manifestPatch === "string"
    ? body.manifestPatch
    : null;

  if (
    body.persisted !== true
    || (receiptResult !== "recorded" && receiptResult !== "already_recorded")
    || !publishedAt
    || !manifestId
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifestId)
    || manifestId !== expected.tutorialId
    || manifestTitle !== approvedTitle
    || manifestTitle !== expected.approvedTitle
    || manifestSourcePath !== expected.sourcePath
    || manifestSourcePath !== `docs/tutorials/${manifestId}.md`
    || manifestStatus !== "rss_confirmed"
    || manifestCanonicalUrl !== canonicalUrl
    || manifestPublishedAt !== publishedAt
    || !Number.isFinite(Date.parse(manifestPublishedAt))
    || !manifestPatch
    || manifestPatch.length > 20_000
    || manifestPatch.includes("\0")
  ) return null;

  const manifestEntry: SubstackManifestEntry = {
    id: manifestId,
    title: manifestTitle,
    sourcePath: manifestSourcePath,
    status: "rss_confirmed",
    canonicalUrl: manifestCanonicalUrl,
    publishedAt: manifestPublishedAt,
  };
  try {
    const parsedPatch = JSON.parse(manifestPatch) as unknown;
    if (
      !isRecord(parsedPatch)
      || JSON.stringify(parsedPatch) !== JSON.stringify(manifestEntry)
      || manifestPatch !== JSON.stringify(manifestEntry, null, 2)
    ) return null;
  } catch {
    return null;
  }

  return {
    ...base,
    status: "rss_confirmed",
    publishedAt,
    persisted: true,
    receiptResult,
    manifestEntry,
    manifestPatch,
  };
}

export function substackVerificationResponseIsCurrent(input: {
  requestGeneration: number;
  currentGeneration: number;
  requestedCanonicalUrl: string;
  currentRawUrl: string;
}): boolean {
  return (
    input.requestGeneration === input.currentGeneration
    && canonicalSubstackPostUrl(input.currentRawUrl)
      === input.requestedCanonicalUrl
  );
}

function terminalStatus(status: string): boolean {
  return [
    "completed",
    "published",
    "partially_published",
    "requires_human_publish",
    "completed_with_errors",
    "dry_run_complete",
    "blocked",
    "failed",
    "rejected",
    "cancelled",
    "canceled",
  ].includes(
    status.toLowerCase(),
  );
}

function sessionRead(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function sessionWrite(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // The in-memory token still works when storage is unavailable.
  }
}

function sessionRemove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing else should retain or expose the credential.
  }
}

export function MarketingOperator(): React.JSX.Element {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [leadTokenInput, setLeadTokenInput] = useState("");
  const [leadToken, setLeadToken] = useState("");
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [xIdentity, setXIdentity] =
    useState<XIdentityVerification | null>(null);
  const [xIdentityState, setXIdentityState] = useState<
    "idle" | "loading" | "verified" | "error"
  >("idle");
  const [xIdentityError, setXIdentityError] = useState("");
  const [discordActivation, setDiscordActivation] =
    useState<DiscordActivationVerification | null>(null);
  const [discordActivationState, setDiscordActivationState] = useState<
    "idle" | "loading" | "verified" | "error"
  >("idle");
  const [discordActivationError, setDiscordActivationError] = useState("");
  const [kind, setKind] = useState<DraftKind>("product_update");
  const [brief, setBrief] = useState("");
  const [interactionUrl, setInteractionUrl] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [channels, setChannels] = useState<Channel[]>(["x", "discord"]);
  const [tutorialId, setTutorialId] = useState("");
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<JsonRecord | null>(null);
  const [comment, setComment] = useState("");
  const [acknowledgedDraftKey, setAcknowledgedDraftKey] = useState("");
  const [leads, setLeads] = useState<OperatorLead[]>([]);
  const [leadScoreFloor, setLeadScoreFloor] = useState(3);
  const [leadQueueState, setLeadQueueState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [leadQueueError, setLeadQueueError] = useState("");
  const [leadScorecard, setLeadScorecard] = useState<LeadScorecard | null>(null);
  const [leadScorecardState, setLeadScorecardState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [leadScorecardError, setLeadScorecardError] = useState("");
  const [leadActionId, setLeadActionId] = useState("");
  const [leadDeleteConfirmId, setLeadDeleteConfirmId] = useState("");
  const [leadActionNotice, setLeadActionNotice] = useState("");
  const [syndicationItems, setSyndicationItems] = useState<
    OperatorSyndicationItem[]
  >([]);
  const [syndicationState, setSyndicationState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [syndicationError, setSyndicationError] = useState("");
  const [syndicationActionId, setSyndicationActionId] = useState("");
  const [syndicationNotice, setSyndicationNotice] = useState("");
  const [syndicationRepair, setSyndicationRepair] =
    useState<SyndicationRepairPair | null>(null);
  const [syndicationSkipConfirmId, setSyndicationSkipConfirmId] = useState("");
  const [busy, setBusy] = useState<
    "connect" | "create" | "approve" | "reject" | ""
  >("");
  const [notice, setNotice] = useState(
    "Enter both operator tokens to load readiness and the operator queues.",
  );
  const [pollRevision, setPollRevision] = useState(0);
  const leadRequestGeneration = useRef(0);
  const leadScorecardRequestGeneration = useRef(0);
  const leadSessionGeneration = useRef(0);
  const leadActionGeneration = useRef(0);
  const syndicationRequestGeneration = useRef(0);
  const xIdentityRequestGeneration = useRef(0);
  const discordPreflightRequestGeneration = useRef(0);

  const readiness = useMemo(() => readinessRows(status), [status]);
  const xActivation = useMemo(() => parseXActivationStatus(status), [status]);
  const tutorialSelections = useMemo(
    () => sourceControlledTutorialSelections(status?.sourceControlledTutorials),
    [status],
  );
  const selectedTutorialId = tutorialSelections.some(
    (selection) => selection.tutorialId === tutorialId,
  )
    ? tutorialId
    : tutorialSelections[0]?.tutorialId ?? "";
  const currentStatus = runStatus(run);
  const draft = draftFrom(run);
  const result = resultFrom(run);
  const draftId = isRecord(draft) ? text(draft.id) : null;
  const displayedDraftKey = runId && draftId ? `${runId}:${draftId}` : "";
  const reviewAcknowledged =
    Boolean(displayedDraftKey) && acknowledgedDraftKey === displayedDraftKey;
  const tutorialApproval = tutorialApprovalEchoFromDraft(draft);
  const needsTutorialApproval = draftRequestsSubstack(draft);
  const canDecide =
    Boolean(draft) && currentStatus === "awaiting_approval" && !busy;
  const canApprove = canDecide
    && reviewAcknowledged
    && (!needsTutorialApproval || tutorialApproval !== null);

  const rememberSyndicationRepair = (
    repair: SyndicationRepairPair | null,
  ): void => {
    setSyndicationRepair(repair);
    if (repair) {
      sessionWrite(SYNDICATION_REPAIR_STORAGE_KEY, JSON.stringify(repair));
    } else {
      sessionRemove(SYNDICATION_REPAIR_STORAGE_KEY);
    }
  };

  const clearOperatorSession = (
    reason: OperatorSessionResetReason,
    message: string,
  ): void => {
    const clearRepair = operatorResetClearsSyndicationRepair(reason);
    sessionRemove(TOKEN_STORAGE_KEY);
    sessionRemove(LEAD_TOKEN_STORAGE_KEY);
    sessionRemove(RUN_STORAGE_KEY);
    if (clearRepair) sessionRemove(SYNDICATION_REPAIR_STORAGE_KEY);
    leadRequestGeneration.current += 1;
    leadScorecardRequestGeneration.current += 1;
    leadSessionGeneration.current += 1;
    leadActionGeneration.current += 1;
    syndicationRequestGeneration.current += 1;
    xIdentityRequestGeneration.current += 1;
    discordPreflightRequestGeneration.current += 1;
    setToken("");
    setTokenInput("");
    setLeadToken("");
    setLeadTokenInput("");
    setStatus(null);
    setXIdentity(null);
    setXIdentityState("idle");
    setXIdentityError("");
    setDiscordActivation(null);
    setDiscordActivationState("idle");
    setDiscordActivationError("");
    setRunId("");
    setRun(null);
    setLeads([]);
    setLeadQueueState("idle");
    setLeadQueueError("");
    setLeadScorecard(null);
    setLeadScorecardState("idle");
    setLeadScorecardError("");
    setLeadActionId("");
    setLeadDeleteConfirmId("");
    setLeadActionNotice("");
    setSyndicationItems([]);
    setSyndicationState("idle");
    setSyndicationError("");
    setSyndicationActionId("");
    setSyndicationNotice("");
    if (clearRepair) setSyndicationRepair(null);
    setSyndicationSkipConfirmId("");
    setAcknowledgedDraftKey("");
    setNotice(message);
  };

  const forgetToken = (): void => {
    clearOperatorSession(
      "explicit_forget",
      "Operator tokens and any pending syndication repair proof were forgotten for this tab.",
    );
  };

  const handleError = (error: unknown, fallback: string): void => {
    const requestError = error as OperatorError;
    if (requestError?.status === 401) {
      clearOperatorSession(
        "auth_rejected",
        "The operator tokens were rejected and removed from this tab. Any pending original-run repair proof was preserved; reconnect with the rotated tokens to retry it.",
      );
      return;
    }
    setNotice(error instanceof Error ? error.message : fallback);
  };

  const loadLeadQueue = async (
    candidateToken: string,
    minimumScore: number,
    expectedSessionGeneration = leadSessionGeneration.current,
  ): Promise<void> => {
    if (leadSessionGeneration.current !== expectedSessionGeneration) return;
    const requestGeneration = leadRequestGeneration.current + 1;
    leadRequestGeneration.current = requestGeneration;
    setLeadQueueState("loading");
    setLeadQueueError("");
    try {
      const body = await operatorRequest(
        `/api/leads?limit=50&minScore=${minimumScore}`,
        candidateToken,
      );
      if (
        leadRequestGeneration.current !== requestGeneration ||
        leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      setLeads(sortLeadsForReview(operatorLeads(body)));
      setLeadQueueState("ready");
    } catch (error) {
      if (
        leadRequestGeneration.current !== requestGeneration ||
        leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The lead queue could not be loaded.");
        return;
      }
      setLeads([]);
      setLeadQueueState("error");
      setLeadQueueError(
        error instanceof Error
          ? error.message
          : "The lead queue could not be loaded.",
      );
    }
  };

  const loadLeadScorecard = async (
    candidateToken: string,
    expectedSessionGeneration = leadSessionGeneration.current,
  ): Promise<void> => {
    if (leadSessionGeneration.current !== expectedSessionGeneration) return;
    const requestGeneration = leadScorecardRequestGeneration.current + 1;
    leadScorecardRequestGeneration.current = requestGeneration;
    setLeadScorecardState("loading");
    setLeadScorecardError("");
    try {
      const body = await operatorRequest(
        "/api/leads/scorecard",
        candidateToken,
      );
      if (
        leadScorecardRequestGeneration.current !== requestGeneration
        || leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      const parsed = parseLeadScorecard(body);
      if (!parsed) throw new Error("The lead scorecard response was invalid.");
      setLeadScorecard(parsed);
      setLeadScorecardState("ready");
    } catch (error) {
      if (
        leadScorecardRequestGeneration.current !== requestGeneration
        || leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The lead scorecard could not be loaded.");
        return;
      }
      setLeadScorecard(null);
      setLeadScorecardState("error");
      setLeadScorecardError(
        error instanceof Error
          ? error.message
          : "The lead scorecard could not be loaded.",
      );
    }
  };

  const loadSyndicationInbox = async (
    candidateToken: string,
    expectedSessionGeneration = leadSessionGeneration.current,
  ): Promise<void> => {
    if (leadSessionGeneration.current !== expectedSessionGeneration) return;
    const requestGeneration = syndicationRequestGeneration.current + 1;
    syndicationRequestGeneration.current = requestGeneration;
    setSyndicationState("loading");
    setSyndicationError("");
    try {
      const body = await operatorRequest(
        "/api/marketing/syndication",
        candidateToken,
      );
      if (
        syndicationRequestGeneration.current !== requestGeneration
        || leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      const nextItems = operatorSyndicationItems(body);
      setSyndicationItems(nextItems);
      setSyndicationState("ready");
      setSyndicationSkipConfirmId((current) =>
        current && nextItems.some(
          (item) => item.itemId === current && item.status === "pending",
        )
          ? current
          : ""
      );
      const deferred = syndicationDeferredCount(body);
      setSyndicationNotice((current) =>
        syndicationNoticeAfterReconciliation(current, deferred)
      );
      const pendingRepair = parseSyndicationRepairPair(
        sessionRead(SYNDICATION_REPAIR_STORAGE_KEY),
      ) ?? syndicationRepair;
      if (
        pendingRepair
        && nextItems.some(
          (item) => item.itemId === pendingRepair.itemId
            && item.workflowRunId === pendingRepair.runId,
        )
      ) {
        rememberSyndicationRepair(null);
      }
    } catch (error) {
      if (
        syndicationRequestGeneration.current !== requestGeneration
        || leadSessionGeneration.current !== expectedSessionGeneration
      ) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The syndication inbox could not be loaded.");
        return;
      }
      setSyndicationItems([]);
      setSyndicationState("error");
      setSyndicationError(
        error instanceof Error
          ? error.message
          : "The syndication inbox could not be loaded.",
      );
    }
  };

  const openSyndicationRun = (nextRunId: string): void => {
    setRunId(nextRunId);
    setRun(null);
    setComment("");
    setAcknowledgedDraftKey("");
    sessionWrite(RUN_STORAGE_KEY, nextRunId);
    setNotice("Loading the selected syndication draft run.");
    setPollRevision((value) => value + 1);
  };

  const actOnSyndicationItem = async (
    itemId: string,
    action: "draft" | "skip",
  ): Promise<void> => {
    if (!token || syndicationActionId) return;
    const actionId = `${action}:${itemId}`;
    const sessionGeneration = leadSessionGeneration.current;
    setSyndicationActionId(actionId);
    setSyndicationNotice("");
    try {
      const body = await operatorRequest("/api/marketing/syndication", token, {
        method: "POST",
        body: JSON.stringify({ action, itemId }),
      });
      if (leadSessionGeneration.current !== sessionGeneration) return;
      if (action === "draft") {
        const nextRunId = runIdFrom(body);
        if (!nextRunId) {
          throw new Error(
            "The syndication draft started without returning its workflow run ID.",
          );
        }
        openSyndicationRun(nextRunId);
        setSyndicationNotice(
          "Review draft started for X and Discord. Nothing has been published.",
        );
      } else {
        setSyndicationSkipConfirmId("");
        setSyndicationNotice("Syndication item skipped. No draft or post was created.");
      }
      await loadSyndicationInbox(token, sessionGeneration);
    } catch (error) {
      if (leadSessionGeneration.current !== sessionGeneration) return;
      const requestError = error as OperatorError;
      if (
        action === "draft"
        && requestError.runId
        && requestError.repairProof
      ) {
        const startedRunId = requestError.runId;
        const repair = {
          itemId,
          runId: startedRunId,
          repairProof: requestError.repairProof,
        };
        rememberSyndicationRepair(repair);
        openSyndicationRun(startedRunId);
        try {
          await operatorRequest("/api/marketing/syndication", token, {
            method: "POST",
            body: JSON.stringify({
              action: "attach",
              itemId,
              runId: startedRunId,
              repairProof: repair.repairProof,
            }),
          });
          setSyndicationNotice(
            "Review draft started and its durable inbox link was repaired. Nothing has been published.",
          );
          rememberSyndicationRepair(null);
          await loadSyndicationInbox(token, sessionGeneration);
        } catch (repairError) {
          if ((repairError as OperatorError)?.status === 401) {
            handleError(
              repairError,
              "The original syndication workflow link could not be repaired.",
            );
            return;
          }
          setSyndicationNotice(
            repairError instanceof Error
              ? `The draft run is open, but its inbox link still needs repair: ${repairError.message}`
              : "The draft run is open, but its inbox link still needs repair.",
          );
        }
        return;
      }
      if (action === "draft" && requestError.runId) {
        openSyndicationRun(requestError.runId);
        setSyndicationNotice(
          "The draft run is open, but no valid durable repair proof was returned. Do not start a replacement workflow.",
        );
        return;
      }
      if (requestError?.status === 401) {
        handleError(error, "The syndication action could not be completed.");
      } else {
        setSyndicationNotice(
          error instanceof Error
            ? error.message
            : "The syndication action could not be completed.",
        );
      }
    } finally {
      if (leadSessionGeneration.current === sessionGeneration) {
        setSyndicationActionId("");
      }
    }
  };

  const retrySyndicationRepair = async (): Promise<void> => {
    const repair = syndicationRepair;
    if (!token || !repair || syndicationActionId) return;
    const sessionGeneration = leadSessionGeneration.current;
    setSyndicationActionId(`attach:${repair.itemId}`);
    setSyndicationNotice("");
    openSyndicationRun(repair.runId);
    try {
      await operatorRequest("/api/marketing/syndication", token, {
        method: "POST",
        body: JSON.stringify({
          action: "attach",
          itemId: repair.itemId,
          runId: repair.runId,
          repairProof: repair.repairProof,
        }),
      });
      if (leadSessionGeneration.current !== sessionGeneration) return;
      rememberSyndicationRepair(null);
      setSyndicationNotice(
        "The original review run is now durably linked. Nothing has been published.",
      );
      await loadSyndicationInbox(token, sessionGeneration);
    } catch (error) {
      if (leadSessionGeneration.current !== sessionGeneration) return;
      if ((error as OperatorError)?.status === 401) {
        handleError(error, "The original syndication workflow link could not be repaired.");
      } else {
        setSyndicationNotice(
          error instanceof Error
            ? `The original run link still needs repair: ${error.message}`
            : "The original run link still needs repair.",
        );
      }
    } finally {
      if (leadSessionGeneration.current === sessionGeneration) {
        setSyndicationActionId("");
      }
    }
  };

  const updateLeadLifecycle = async (
    id: string,
    status: Exclude<LeadStatus, "new">,
  ): Promise<void> => {
    if (!leadToken || leadActionId) return;
    const sessionGeneration = leadSessionGeneration.current;
    const actionGeneration = leadActionGeneration.current + 1;
    leadActionGeneration.current = actionGeneration;
    setLeadActionId(id);
    setLeadActionNotice("");
    try {
      await operatorRequest(`/api/leads/${encodeURIComponent(id)}`, leadToken, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (!leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) return;
      setLeadDeleteConfirmId("");
      setLeadActionNotice(`Request marked ${titleCase(status)}.`);
      await Promise.all([
        loadLeadQueue(leadToken, leadScoreFloor, sessionGeneration),
        loadLeadScorecard(leadToken, sessionGeneration),
      ]);
    } catch (error) {
      if (!leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The request status could not be updated.");
      } else {
        setLeadActionNotice(
          error instanceof Error
            ? error.message
            : "The request status could not be updated.",
        );
      }
    } finally {
      if (leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) setLeadActionId("");
    }
  };

  const permanentlyDeleteLead = async (id: string): Promise<void> => {
    if (!leadToken || leadActionId) return;
    const sessionGeneration = leadSessionGeneration.current;
    const actionGeneration = leadActionGeneration.current + 1;
    leadActionGeneration.current = actionGeneration;
    setLeadActionId(id);
    setLeadActionNotice("");
    try {
      await operatorRequest(`/api/leads/${encodeURIComponent(id)}`, leadToken, {
        method: "DELETE",
      });
      if (!leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) return;
      setLeadDeleteConfirmId("");
      setLeadActionNotice("Request permanently deleted.");
      await Promise.all([
        loadLeadQueue(leadToken, leadScoreFloor, sessionGeneration),
        loadLeadScorecard(leadToken, sessionGeneration),
      ]);
    } catch (error) {
      if (!leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "The request could not be deleted.");
      } else {
        setLeadActionNotice(
          error instanceof Error ? error.message : "The request could not be deleted.",
        );
      }
    } finally {
      if (leadOperationIsCurrent({
        expectedSessionGeneration: sessionGeneration,
        expectedActionGeneration: actionGeneration,
        currentSessionGeneration: leadSessionGeneration.current,
        currentActionGeneration: leadActionGeneration.current,
      })) setLeadActionId("");
    }
  };

  useEffect(() => {
    const storedToken = sessionRead(TOKEN_STORAGE_KEY);
    const storedLeadToken = sessionRead(LEAD_TOKEN_STORAGE_KEY);
    if (!storedToken || !storedLeadToken) return;

    let cancelled = false;
    const sessionGeneration = leadSessionGeneration.current + 1;
    leadSessionGeneration.current = sessionGeneration;
    leadRequestGeneration.current += 1;
    leadScorecardRequestGeneration.current += 1;
    leadActionGeneration.current += 1;
    void operatorRequest("/api/marketing/status", storedToken)
      .then((body) => {
        if (
          cancelled ||
          leadSessionGeneration.current !== sessionGeneration
        ) return;
        setTokenInput(storedToken);
        setToken(storedToken);
        setLeadTokenInput(storedLeadToken);
        setLeadToken(storedLeadToken);
        setStatus(body);
        const storedRepairValue = sessionRead(SYNDICATION_REPAIR_STORAGE_KEY);
        const storedRepair = parseSyndicationRepairPair(storedRepairValue);
        if (storedRepair) setSyndicationRepair(storedRepair);
        else if (storedRepairValue) sessionRemove(SYNDICATION_REPAIR_STORAGE_KEY);
        const recoveredRunId =
          marketingRunIdFromSearch(window.location.search)
          || sessionRead(RUN_STORAGE_KEY);
        if (recoveredRunId) {
          sessionWrite(RUN_STORAGE_KEY, recoveredRunId);
          setRunId(recoveredRunId);
        }
        void loadLeadQueue(storedLeadToken, 3, sessionGeneration);
        void loadLeadScorecard(storedLeadToken, sessionGeneration);
        void loadSyndicationInbox(storedToken, sessionGeneration);
        setNotice("Operator session restored. Readiness is current.");
      })
      .catch((error: unknown) => {
        if (!cancelled) handleError(error, "Could not restore the operator session.");
      });

    return () => {
      cancelled = true;
    };
    // This runs once to restore only the credential scoped to this browser tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!token || !runId) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failureCount = 0;

    const poll = async (): Promise<void> => {
      if (document.hidden) {
        timeout = setTimeout(() => void poll(), POLL_MAX_INTERVAL_MS);
        return;
      }
      try {
        const body = await operatorRequest(`/api/marketing/runs/${encodeURIComponent(runId)}`, token);
        if (cancelled) return;
        failureCount = 0;
        const nextRun = nestedRun(body);
        setRun(nextRun);
        const nextStatus = runStatus(nextRun);
        setNotice(
          draftFrom(nextRun)
            ? `Draft ready · ${titleCase(nextStatus)}.`
            : `Generating draft · ${titleCase(nextStatus)}.`,
        );
        if (terminalStatus(nextStatus)) {
          void loadSyndicationInbox(token, leadSessionGeneration.current);
        } else {
          timeout = setTimeout(
            () => void poll(),
            nextStatus === "awaiting_approval"
              ? POLL_MAX_INTERVAL_MS
              : POLL_INTERVAL_MS,
          );
        }
      } catch (error) {
        if (cancelled) return;
        const requestError = error as OperatorError;
        handleError(error, "The run could not be refreshed.");
        if (shouldRetryPoll(requestError?.status)) {
          failureCount += 1;
          timeout = setTimeout(() => void poll(), pollRetryDelay(failureCount));
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
    // pollRevision restarts polling after an approval response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollRevision, runId, token]);

  const connect = async (): Promise<void> => {
    const candidate = tokenInput.trim();
    const candidateLeadToken = leadTokenInput.trim();
    if (!candidate || !candidateLeadToken || busy) {
      setNotice("Enter both separately scoped operator tokens.");
      return;
    }

    setBusy("connect");
    const sessionGeneration = leadSessionGeneration.current + 1;
    leadSessionGeneration.current = sessionGeneration;
    leadRequestGeneration.current += 1;
    leadScorecardRequestGeneration.current += 1;
    leadActionGeneration.current += 1;
    syndicationRequestGeneration.current += 1;
    xIdentityRequestGeneration.current += 1;
    discordPreflightRequestGeneration.current += 1;
    setXIdentity(null);
    setXIdentityState("idle");
    setXIdentityError("");
    setDiscordActivation(null);
    setDiscordActivationState("idle");
    setDiscordActivationError("");
    try {
      const body = await operatorRequest("/api/marketing/status", candidate);
      if (leadSessionGeneration.current !== sessionGeneration) return;
      sessionWrite(TOKEN_STORAGE_KEY, candidate);
      sessionWrite(LEAD_TOKEN_STORAGE_KEY, candidateLeadToken);
      setToken(candidate);
      setLeadToken(candidateLeadToken);
      setStatus(body);
      const storedRepairValue = sessionRead(SYNDICATION_REPAIR_STORAGE_KEY);
      const storedRepair = parseSyndicationRepairPair(storedRepairValue);
      if (storedRepair) setSyndicationRepair(storedRepair);
      else if (storedRepairValue) sessionRemove(SYNDICATION_REPAIR_STORAGE_KEY);
      const recoveredRunId =
        marketingRunIdFromSearch(window.location.search)
        || sessionRead(RUN_STORAGE_KEY);
      if (recoveredRunId) {
        sessionWrite(RUN_STORAGE_KEY, recoveredRunId);
        setRunId(recoveredRunId);
      }
      setNotice("Connected. Readiness is current.");
      await Promise.all([
        loadLeadQueue(
          candidateLeadToken,
          leadScoreFloor,
          sessionGeneration,
        ),
        loadLeadScorecard(candidateLeadToken, sessionGeneration),
        loadSyndicationInbox(candidate, sessionGeneration),
      ]);
    } catch (error) {
      handleError(error, "Could not load marketing readiness.");
    } finally {
      setBusy("");
    }
  };

  const verifyXIdentity = async (): Promise<void> => {
    if (!token || xIdentityState === "loading") return;
    const expectedSessionGeneration = leadSessionGeneration.current;
    const requestGeneration = xIdentityRequestGeneration.current + 1;
    xIdentityRequestGeneration.current = requestGeneration;
    setXIdentity(null);
    setXIdentityState("loading");
    setXIdentityError("");
    try {
      const body = await operatorRequest("/api/marketing/x/identity", token);
      if (
        !xIdentityRequestIsCurrent({
          requestGeneration,
          currentRequestGeneration: xIdentityRequestGeneration.current,
          sessionGeneration: expectedSessionGeneration,
          currentSessionGeneration: leadSessionGeneration.current,
        })
      ) return;
      const verified = parseXIdentityVerification(body);
      if (!verified) {
        throw new Error("The X identity response was invalid.");
      }
      setXIdentity(verified);
      setXIdentityState("verified");
    } catch (error) {
      if (
        !xIdentityRequestIsCurrent({
          requestGeneration,
          currentRequestGeneration: xIdentityRequestGeneration.current,
          sessionGeneration: expectedSessionGeneration,
          currentSessionGeneration: leadSessionGeneration.current,
        })
      ) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "X identity could not be verified.");
        return;
      }
      setXIdentity(null);
      setXIdentityState("error");
      setXIdentityError(
        error instanceof Error
          ? error.message
          : "X identity could not be verified.",
      );
    }
  };

  const verifyDiscordActivation = async (): Promise<void> => {
    if (!token || discordActivationState === "loading") return;
    const expectedSessionGeneration = leadSessionGeneration.current;
    const requestGeneration = discordPreflightRequestGeneration.current + 1;
    discordPreflightRequestGeneration.current = requestGeneration;
    setDiscordActivation(null);
    setDiscordActivationState("loading");
    setDiscordActivationError("");
    try {
      const body = await operatorRequest(
        "/api/marketing/discord/preflight",
        token,
      );
      if (
        !discordPreflightRequestIsCurrent({
          requestGeneration,
          currentRequestGeneration: discordPreflightRequestGeneration.current,
          sessionGeneration: expectedSessionGeneration,
          currentSessionGeneration: leadSessionGeneration.current,
        })
      ) return;
      const verified = parseDiscordActivationVerification(body);
      if (!verified) {
        throw new Error("The Discord preflight response was invalid.");
      }
      setDiscordActivation(verified);
      setDiscordActivationState("verified");
    } catch (error) {
      if (
        !discordPreflightRequestIsCurrent({
          requestGeneration,
          currentRequestGeneration: discordPreflightRequestGeneration.current,
          sessionGeneration: expectedSessionGeneration,
          currentSessionGeneration: leadSessionGeneration.current,
        })
      ) return;
      const requestError = error as OperatorError;
      if (requestError?.status === 401) {
        handleError(error, "Discord preflight could not be completed.");
        return;
      }
      setDiscordActivation(null);
      setDiscordActivationState("error");
      setDiscordActivationError(
        error instanceof Error
          ? error.message
          : "Discord preflight could not be completed.",
      );
    }
  };

  const toggleChannel = (channel: Channel): void => {
    if (kind === "community_reply" && channel !== "x") return;
    if (channel === "substack" && kind !== "tutorial") return;
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((candidate) => candidate !== channel)
        : [...current, channel],
    );
  };

  const createDraft = async (): Promise<void> => {
    if (!token || busy) return;
    if (!brief.trim()) {
      setNotice("Add the facts and objective for this draft.");
      return;
    }
    if (channels.length === 0) {
      setNotice("Select at least one channel.");
      return;
    }
    if (
      channels.includes("substack")
      && !selectedTutorialId
    ) {
      setNotice("Select a byte-verified source-controlled tutorial for Substack.");
      return;
    }
    let verifiedInteractionUrl: string | undefined;
    if (kind === "community_reply") {
      try {
        verifiedInteractionUrl = parseCanonicalXStatusUrl(interactionUrl).url;
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Add a canonical X post URL for the reply target.",
        );
        return;
      }
    }

    let parsedSources: string[];
    try {
      parsedSources = parseMarketingSourceUrls(sourceUrls);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Check the source URLs.");
      return;
    }

    setBusy("create");
    setRun(null);
    setComment("");
    setAcknowledgedDraftKey("");
    try {
      const body = await operatorRequest("/api/marketing/runs", token, {
        method: "POST",
        body: JSON.stringify({
          kind,
          brief: brief.trim(),
          channels,
          ...(channels.includes("substack")
            ? { tutorialId: selectedTutorialId }
            : {}),
          ...(verifiedInteractionUrl ? { interactionUrl: verifiedInteractionUrl } : {}),
          ...(parsedSources.length ? { sourceUrls: parsedSources } : {}),
        }),
      });
      const nextRunId = runIdFrom(body);
      if (!nextRunId) throw new Error("The agent started without returning a run ID.");

      setRunId(nextRunId);
      setRun(nestedRun(body));
      sessionWrite(RUN_STORAGE_KEY, nextRunId);
      setNotice("Run started. Waiting for a reviewable draft.");
      setPollRevision((value) => value + 1);
    } catch (error) {
      handleError(error, "The draft could not be started.");
    } finally {
      setBusy("");
    }
  };

  const decide = async (decision: "approve" | "reject"): Promise<void> => {
    if (
      !token
      || !runId
      || !canDecide
      || (decision === "approve" && !canApprove)
    ) return;

    setBusy(decision);
    try {
      const body = await operatorRequest("/api/marketing/approvals", token, {
        method: "POST",
        body: JSON.stringify({
          runId,
          decision,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(decision === "approve" && tutorialApproval
            ? { tutorialApproval }
            : {}),
        }),
      });
      if (draftFrom(body) || resultFrom(body) || text(body.status)) {
        setRun((current) => ({ ...(current ?? {}), ...nestedRun(body) }));
      }
      setNotice(
        decision === "approve"
          ? "Approval recorded. Publishing adapters will report their outcome here."
          : "Draft rejected. No channel publication was authorized.",
      );
      setAcknowledgedDraftKey("");
      setPollRevision((value) => value + 1);
    } catch (error) {
      handleError(error, `The ${decision} decision could not be recorded.`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className={styles.operator}>
      <section className={styles.panel} aria-labelledby="operator-access">
        <div className={styles.sectionHead}>
          <div>
            <span className={styles.step}>01</span>
            <h2 id="operator-access">Operator access</h2>
          </div>
          <StatusChip
            ready={Boolean(token && leadToken)}
            label={token && leadToken ? "connected" : "locked"}
          />
        </div>

        <label className={styles.field}>
          <span>Marketing approval token</span>
          <span className={styles.inlineControl}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              disabled={Boolean(token && leadToken)}
              placeholder="Publishing-scope bearer token"
            />
          </span>
        </label>
        <label className={styles.field}>
          <span>Lead desk token</span>
          <span className={styles.inlineControl}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={leadTokenInput}
              onChange={(event) => setLeadTokenInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              disabled={Boolean(token && leadToken)}
              placeholder="Lead-data-scope bearer token"
            />
            {token && leadToken ? (
              <button className={styles.secondaryButton} type="button" onClick={() => forgetToken()}>
                Forget
              </button>
            ) : (
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void connect()}
                disabled={busy === "connect"}
              >
                {busy === "connect" ? "Checking…" : "Connect"}
              </button>
            )}
          </span>
        </label>
        <p className={styles.hint}>
          Separate tokens keep publication authority apart from private lead
          access. Both stay in <code>sessionStorage</code> for this tab only;
          neither is placed in a URL, cookie, or persistent local storage.
        </p>
      </section>

      {token && leadToken ? (
        <>
          <section className={styles.panel} aria-labelledby="channel-readiness">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>02</span>
                <h2 id="channel-readiness">Readiness</h2>
              </div>
              <button
                className={styles.textButton}
                type="button"
                onClick={() => void connect()}
                disabled={Boolean(busy)}
              >
                Refresh
              </button>
            </div>
            <p className={styles.readinessScope}>
              Configuration snapshot only. Provider identity, destination,
              durable admission, and write availability are rechecked at the
              action boundary.
            </p>
            <div className={styles.readinessEvidence}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void verifyXIdentity()}
                disabled={xIdentityState === "loading" || Boolean(busy)}
              >
                {xIdentityState === "loading"
                  ? "Verifying X…"
                  : "Verify X identity"}
              </button>
              <p
                className={
                  xIdentityState === "error"
                    ? styles.readinessEvidenceError
                    : styles.readinessEvidenceText
                }
                aria-live="polite"
              >
                {xIdentity
                  ? (
                      <>
                        Verified through the official X API as @
                        {xIdentity.authenticatedUsername} · account{" "}
                        {xIdentity.authenticatedAccountId} ·{" "}
                        <time dateTime={xIdentity.observedAt}>
                          {LEAD_DATE_FORMATTER.format(
                            new Date(xIdentity.observedAt),
                          )}
                        </time>
                        . Identity only; this does not prove the Automated
                        label or write availability.
                      </>
                    )
                  : xIdentityState === "error"
                    ? xIdentityError
                    : "No live X API identity check has been run in this tab."}
              </p>
            </div>
            <div className={styles.readinessEvidence}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void verifyDiscordActivation()}
                disabled={discordActivationState === "loading" || Boolean(busy)}
              >
                {discordActivationState === "loading"
                  ? "Verifying Discord…"
                  : DISCORD_PREFLIGHT_BUTTON_LABEL}
              </button>
              <p
                className={
                  discordActivationState === "error"
                  || (discordActivation
                    && discordActivation.commandReadback.status !== "in_sync")
                    ? styles.readinessEvidenceError
                    : styles.readinessEvidenceText
                }
                aria-live="polite"
              >
                {discordActivation
                  ? discordActivationSummary(discordActivation)
                  : discordActivationState === "error"
                    ? discordActivationError
                    : "No live Discord destination and command-manifest check has been run in this tab."}
              </p>
            </div>
            {readiness.length ? (
              <div className={styles.readinessGrid}>
                {readiness.map((item) => (
                  <article className={styles.readinessCard} key={item.key}>
                    <div>
                      <h3>{item.label}</h3>
                      <StatusChip ready={item.ready} label={item.state} />
                    </div>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>The status endpoint returned no readiness checks.</p>
            )}
          </section>

          <XActivationApprovalPanel status={xActivation} />

          <section className={styles.panel} aria-labelledby="lead-request-queue">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>03</span>
                <h2 id="lead-request-queue">Qualified Zap requests</h2>
              </div>
              <div className={styles.queueControls}>
                <label>
                  Minimum score
                  <select
                    value={leadScoreFloor}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setLeadScoreFloor(next);
                      void loadLeadQueue(leadToken, next);
                    }}
                    disabled={
                      leadQueueState === "loading" || Boolean(leadActionId)
                    }
                  >
                    <option value={0}>All</option>
                    <option value={3}>3+</option>
                    <option value={4}>4+</option>
                    <option value={5}>5 only</option>
                  </select>
                </label>
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() => void Promise.all([
                    loadLeadQueue(leadToken, leadScoreFloor),
                    loadLeadScorecard(leadToken),
                  ])}
                  disabled={
                    leadQueueState === "loading"
                    || leadScorecardState === "loading"
                    || Boolean(leadActionId)
                  }
                >
                  {leadQueueState === "loading" || leadScorecardState === "loading"
                    ? "Loading…"
                    : "Refresh"}
                </button>
              </div>
            </div>

            {leadScorecardState === "loading" ? (
              <p className={styles.scorecardStatus} role="status" aria-live="polite">
                Loading the accepted-request scorecard.
              </p>
            ) : leadScorecardState === "error" ? (
              <div className={styles.scorecardError} role="status">
                <strong>Scorecard unavailable.</strong>
                <span>{leadScorecardError}</span>
                <span>The private request queue remains available below.</span>
              </div>
            ) : leadScorecard ? (
              <div className={styles.leadScorecard}>
                <div className={styles.scorecardGrid}>
                  <article>
                    <span>Accepted · 7d</span>
                    <strong>{leadScorecard.windows.days7.accepted}</strong>
                    <small>{leadScorecard.windows.days7.score3Plus} scored 3+</small>
                  </article>
                  <article>
                    <span>Accepted · 30d</span>
                    <strong>{leadScorecard.windows.days30.accepted}</strong>
                    <small>{leadScorecard.windows.days30.progressed} progressed</small>
                  </article>
                  <article>
                    <span>Score 3+ · 30d</span>
                    <strong>{leadScorecard.windows.days30.score3Plus}</strong>
                    <small>Current intake score, not outreach</small>
                  </article>
                  <article>
                    <span>Current qualified · 30d</span>
                    <strong>
                      {leadScorecard.windows.days30.currentQualified}
                    </strong>
                    <small>Currently in the qualified lifecycle stage</small>
                  </article>
                  <article data-alert={leadScorecard.overdueReviewCount > 0 || undefined}>
                    <span>Review overdue</span>
                    <strong>{leadScorecard.overdueReviewCount}</strong>
                    <small>Score 3+ and still new after two business days</small>
                  </article>
                </div>
                {leadScorecard.attribution.length ? (
                  <div className={styles.scorecardAttribution}>
                    <h3>30-day accepted-request attribution</h3>
                    <div role="table" aria-label="Accepted request attribution">
                      <div role="row">
                        <span role="columnheader">Source / campaign</span>
                        <span role="columnheader">Accepted</span>
                        <span role="columnheader">3+</span>
                        <span role="columnheader">Current qual.</span>
                      </div>
                      {leadScorecard.attribution.map((row) => (
                        <div
                          role="row"
                          key={`${row.source}:${row.campaign}:${row.content}`}
                        >
                          <span role="cell">
                            {titleCase(row.source)} · {titleCase(row.campaign)}
                            {row.content !== "not_set"
                              ? ` · ${titleCase(row.content)}`
                              : ""}
                          </span>
                          <span role="cell">{row.accepted}</span>
                          <span role="cell">{row.score3Plus}</span>
                          <span role="cell">{row.currentQualified}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className={styles.scorecardScope}>
                  Accepted requests onward only; this does not claim
                  impression-to-lead or visitor-to-request conversion. {" "}
                  {leadScorecard.scope.truncated
                    ? "Based on the top 100 non-expired requests ranked by score, then recency; totals are lower bounds."
                    : `All ${leadScorecard.scope.returnedRows} currently stored, non-expired requests are represented; retention means this is not an all-time count.`}
                </p>
              </div>
            ) : null}

            {leadQueueState === "loading" ? (
              <div className={styles.generating} role="status" aria-live="polite">
                <span aria-hidden />
                <p>Loading the private request queue.</p>
              </div>
            ) : leadQueueState === "error" ? (
              <div className={styles.queueError} role="status">
                <strong>Lead queue unavailable.</strong>
                <span>{leadQueueError}</span>
              </div>
            ) : leads.length ? (
              <div className={styles.leadQueue}>
                {leads.map((lead) => {
                  const reviewSla = leadReviewSla(lead);
                  return (
                  <article
                    className={styles.leadCard}
                    data-review-overdue={reviewSla?.state === "overdue" || undefined}
                    key={lead.id}
                  >
                    <header>
                      <div>
                        <span className={styles.leadPersona}>{titleCase(lead.persona)}</span>
                        <h3>{lead.project ?? lead.name}</h3>
                        {lead.project ? <p>{lead.name}</p> : null}
                      </div>
                      <span
                        className={styles.leadScore}
                        data-qualified={lead.qualificationScore >= 3 || undefined}
                        aria-label={`Qualification score ${lead.qualificationScore} out of 5`}
                      >
                        {lead.qualificationScore}/5
                      </span>
                    </header>

                    <div className={styles.leadContact}>
                      <span>{lead.email}</span>
                      <span
                        data-email-state={
                          lead.emailVerified ? "verified" : "unverified"
                        }
                      >
                        {lead.emailVerified
                          ? "Email verified"
                          : "Email unverified · request-specific reply only"}
                      </span>
                      <a
                        href={leadReplyHref(lead.email)}
                        aria-label={`Reply to ${lead.name} about this Zap request by email`}
                      >
                        Reply by email
                      </a>
                      {lead.projectUrl ? (
                        <a
                          href={lead.projectUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Project ↗
                        </a>
                      ) : null}
                    </div>

                    <dl className={styles.leadBrief}>
                      <div>
                        <dt>Workflow</dt>
                        <dd>{lead.workflow}</dd>
                      </div>
                      <div>
                        <dt>Trigger</dt>
                        <dd>{lead.trigger}</dd>
                      </div>
                      <div>
                        <dt>Must never change</dt>
                        <dd>{lead.guardrails}</dd>
                      </div>
                      {lead.protocolsAssets ? (
                        <div>
                          <dt>Protocols / assets</dt>
                          <dd>{lead.protocolsAssets}</dd>
                        </div>
                      ) : null}
                    </dl>

                    <footer>
                      <span>{titleCase(lead.timeline)}</span>
                      <span>{titleCase(lead.status)}</span>
                      <span>{leadDate(lead.createdAt)} ET</span>
                      {reviewSla ? (
                        <span
                          className={styles.leadReviewSla}
                          data-overdue={reviewSla.state === "overdue" || undefined}
                        >
                          {reviewSla.state === "overdue" ? "Review overdue" : "Review due"}
                          {" · "}{leadDate(reviewSla.dueAt)} ET
                        </span>
                      ) : null}
                      {text(lead.attribution.utmSource) ? (
                        <span>Source: {text(lead.attribution.utmSource)}</span>
                      ) : null}
                      {text(lead.attribution.entryPoint) === "builder_review" ? (
                        <span>Entry: Builder review</span>
                      ) : null}
                    </footer>
                    <div className={styles.leadActions}>
                      {lead.status === "new" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "contacted")}
                          disabled={Boolean(leadActionId)}
                        >
                          Mark contacted
                        </button>
                      ) : null}
                      {lead.status === "new" || lead.status === "contacted" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "qualified")}
                          disabled={Boolean(leadActionId)}
                        >
                          Qualify
                        </button>
                      ) : null}
                      {lead.status !== "closed" ? (
                        <button
                          type="button"
                          onClick={() => void updateLeadLifecycle(lead.id, "closed")}
                          disabled={Boolean(leadActionId)}
                        >
                          Close
                        </button>
                      ) : null}
                      <LeadDeleteControls
                        leadId={lead.id}
                        expanded={leadDeleteConfirmId === lead.id}
                        busy={Boolean(leadActionId)}
                        onToggle={() => setLeadDeleteConfirmId(
                          leadDeleteConfirmId === lead.id ? "" : lead.id,
                        )}
                        onConfirm={() => void permanentlyDeleteLead(lead.id)}
                        onCancel={() => setLeadDeleteConfirmId("")}
                      />
                    </div>
                  </article>
                  );
                })}
              </div>
            ) : leadQueueState === "ready" ? (
              <p className={styles.empty}>
                No active requests meet this score threshold.
              </p>
            ) : null}
            {leadQueueState === "ready" ? (
              <p className="srOnly" role="status" aria-live="polite">
                {leads.length === 1
                  ? "1 request loaded."
                  : `${leads.length} requests loaded.`}
              </p>
            ) : null}
            {leadActionNotice ? (
              <p className={styles.queueNotice} role="status" aria-live="polite">
                {leadActionNotice}
              </p>
            ) : null}
            <p className={styles.hint}>
              Private contact and workflow data is shown only after operator
              authentication. Requests are never enrolled in a marketing list.
            </p>
          </section>

          <section className={styles.panel} aria-labelledby="syndication-inbox">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>04</span>
                <h2 id="syndication-inbox">Feed syndication inbox</h2>
              </div>
              <button
                className={styles.textButton}
                type="button"
                onClick={() => void loadSyndicationInbox(token)}
                disabled={
                  syndicationState === "loading"
                  || Boolean(syndicationActionId)
                }
              >
                {syndicationState === "loading" ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <p className={styles.readinessScope}>
              New approved OpenZaps updates and RSS-confirmed DeFi Tutorials
              posts are deduplicated here. Discovery cannot publish or enter
              the automatic campaign queue.
            </p>
            {syndicationState === "error" ? (
              <div className={styles.queueError} role="alert">
                <span>{syndicationError}</span>
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() => void loadSyndicationInbox(token)}
                >
                  Try again
                </button>
              </div>
            ) : null}
            {syndicationItems.length ? (
              <div className={styles.syndicationInbox}>
                {syndicationItems.map((item) => {
                  const canDraft = syndicationItemCanDraft(item);
                  const canSkip = item.status === "pending";
                  const canRepair = syndicationRepairMatchesItem(
                    item,
                    syndicationRepair,
                  );
                  const itemBusy = syndicationActionId.endsWith(item.itemId);
                  return (
                    <article className={styles.syndicationCard} key={item.itemId}>
                      <header>
                        <div>
                          <span className={styles.leadPersona}>
                            {item.source === "openzaps"
                              ? "OpenZaps update"
                              : "DeFi Tutorials"}
                          </span>
                          <h3>{item.title}</h3>
                          <p>
                            {item.publishedAt
                              ? `Published ${leadDate(item.publishedAt)}`
                              : "Publication time unavailable"}
                          </p>
                        </div>
                        <StatusChip
                          ready={[
                            "pending",
                            "drafting",
                            "awaiting_approval",
                            "published",
                          ].includes(item.status)}
                          label={item.status}
                        />
                      </header>
                      <a
                        className={styles.syndicationLink}
                        href={item.canonicalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open canonical source
                      </a>
                      <div className={styles.syndicationMeta}>
                        <span>{titleCase(item.classification)}</span>
                        <span>Campaign {item.campaignSlug}</span>
                      </div>
                      {item.classification === "needs_classification" ? (
                        <p className={styles.hint}>
                          This Substack item does not match an RSS-confirmed
                          tutorial manifest entry and cannot create a draft.
                        </p>
                      ) : null}
                      {item.classification === "reviewable"
                        && item.status === "pending"
                        && !canDraft ? (
                          <p className={styles.hint} role="alert">
                            This canonical source is too long for the exact X
                            attribution link plus the mandatory disclosure. It
                            cannot be claimed; skip it instead.
                          </p>
                        ) : null}
                      {item.status === "drafting" && !item.workflowRunId ? (
                        <p className={styles.hint} role="alert">
                          A workflow start was claimed without a durable run
                          link. Use the authenticated repair action with the
                          original run ID; do not start a replacement workflow.
                        </p>
                      ) : null}
                      {item.workflowRunId || canDraft || canSkip || canRepair ? (
                        <div className={styles.syndicationActions}>
                          {item.workflowRunId ? (
                            <button
                              type="button"
                              onClick={() => openSyndicationRun(item.workflowRunId!)}
                              disabled={Boolean(syndicationActionId)}
                            >
                              Open draft run
                            </button>
                          ) : null}
                          {canDraft ? (
                            <button
                              type="button"
                              onClick={() => void actOnSyndicationItem(
                                item.itemId,
                                "draft",
                              )}
                              disabled={Boolean(syndicationActionId)}
                            >
                              {itemBusy && syndicationActionId.startsWith("draft:")
                                ? "Starting…"
                                : "Draft X + Discord"}
                            </button>
                          ) : null}
                          {canRepair ? (
                            <button
                              type="button"
                              onClick={() => void retrySyndicationRepair()}
                              disabled={Boolean(syndicationActionId)}
                            >
                              {itemBusy && syndicationActionId.startsWith("attach:")
                                ? "Repairing…"
                                : "Retry original run link"}
                            </button>
                          ) : null}
                          {canSkip ? (
                            <SyndicationSkipControls
                              itemId={item.itemId}
                              expanded={syndicationSkipConfirmId === item.itemId}
                              busy={Boolean(syndicationActionId)}
                              submitting={
                                itemBusy
                                && syndicationActionId.startsWith("skip:")
                              }
                              onToggle={() => setSyndicationSkipConfirmId(
                                syndicationSkipConfirmId === item.itemId
                                  ? ""
                                  : item.itemId,
                              )}
                              onConfirm={() => {
                                setSyndicationSkipConfirmId("");
                                void actOnSyndicationItem(item.itemId, "skip");
                              }}
                              onCancel={() => setSyndicationSkipConfirmId("")}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : syndicationState === "ready" ? (
              <p className={styles.empty}>No feed items need operator action.</p>
            ) : syndicationState === "loading" ? (
              <p className={styles.empty}>Loading the review-only inbox…</p>
            ) : null}
            {syndicationNotice ? (
              <p className={styles.queueNotice} role="status" aria-live="polite">
                {syndicationNotice}
              </p>
            ) : null}
            <p className={styles.hint}>
              “Draft X + Discord” starts the existing source-backed workflow.
              Every generated post still requires explicit owner approval.
            </p>
          </section>

          <section className={styles.panel} aria-labelledby="create-marketing-draft">
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.step}>05</span>
                <h2 id="create-marketing-draft">Create a review draft</h2>
              </div>
            </div>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Content type</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    const nextKind = event.target.value as DraftKind;
                    setKind(nextKind);
                    if (nextKind === "community_reply") {
                      setChannels(["x"]);
                    } else if (nextKind !== "tutorial") {
                      setChannels((current) =>
                        current.filter((channel) => channel !== "substack")
                      );
                    }
                  }}
                >
                  <option value="product_update">Product update</option>
                  <option value="tutorial">Tutorial</option>
                  <option value="community_reply">Verified X reply</option>
                </select>
              </label>

              <fieldset className={styles.channelPicker}>
                <legend>Channels</legend>
                <div>
                  {CHANNELS.map((channel) => (
                    <label key={channel}>
                      <input
                        type="checkbox"
                        checked={channels.includes(channel)}
                        onChange={() => toggleChannel(channel)}
                        disabled={
                          (kind === "community_reply" && channel !== "x")
                          || (channel === "substack" && kind !== "tutorial")
                        }
                      />
                      <span>{channel === "x" ? "X" : titleCase(channel)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            {channels.includes("substack") ? (
              <label className={styles.field}>
                <span>Source-controlled Substack tutorial</span>
                <select
                  value={selectedTutorialId}
                  onChange={(event) => setTutorialId(event.target.value)}
                  disabled={tutorialSelections.length === 0}
                >
                  {tutorialSelections.length === 0 ? (
                    <option value="">No byte-verified tutorial is available</option>
                  ) : tutorialSelections.map((selection) => (
                    <option key={selection.tutorialId} value={selection.tutorialId}>
                      {selection.title} · {titleCase(selection.manifestStatus)}
                    </option>
                  ))}
                </select>
                <small>
                  Substack copy comes from the selected reviewed Markdown file.
                  The model cannot rewrite it, and approval binds both exact hashes.
                </small>
              </label>
            ) : null}

            <label className={styles.field}>
              <span>
                {kind === "community_reply"
                  ? "Your paraphrase of the question"
                  : "Brief and verified facts"}
              </span>
              <textarea
                rows={6}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder={
                  kind === "community_reply"
                    ? "Paraphrase what the person is asking. Do not paste the post text…"
                    : "What shipped, why it matters, and which claims the source material supports…"
                }
              />
            </label>

            {kind === "community_reply" ? (
              <label className={styles.field}>
                <span>X reply target</span>
                <input
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  value={interactionUrl}
                  onChange={(event) => setInteractionUrl(event.target.value)}
                  placeholder="https://x.com/username/status/1234567890123456789"
                />
                <small>
                  The agent verifies this post through X&apos;s API. It stores only
                  author/trigger metadata and never sends or persists the post text.
                </small>
              </label>
            ) : null}

            <label className={styles.field}>
              <span>Source URLs <small>optional · one per line</small></span>
              <textarea
                rows={3}
                inputMode="url"
                value={sourceUrls}
                onChange={(event) => setSourceUrls(event.target.value)}
                placeholder={"https://www.0xzaps.com/...\nhttps://github.com/0pen-Zaps/openzaps/..."}
              />
            </label>

            <div className={styles.actionRow}>
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void createDraft()}
                disabled={Boolean(busy)}
              >
                {busy === "create" ? "Starting…" : "Create review draft"}
              </button>
              <span>Generation cannot publish. A separate approval is required.</span>
            </div>
          </section>

          {runId ? (
            <section className={styles.panel} aria-labelledby="review-marketing-draft">
              <div className={styles.sectionHead}>
                <div>
                  <span className={styles.step}>06</span>
                  <h2 id="review-marketing-draft">Review and decide</h2>
                </div>
                <StatusChip
                  ready={
                    Boolean(draft)
                    && ![
                      "blocked",
                      "failed",
                      "rejected",
                      "partially_published",
                      "requires_human_publish",
                      "completed_with_errors",
                      "cancelled",
                      "canceled",
                    ].includes(currentStatus)
                  }
                  label={currentStatus}
                />
              </div>

              <p className={styles.runMeta}>
                Run <code>{runId}</code>
              </p>

              {draft ? (
                <DraftReview
                  draft={draft}
                  operatorToken={token}
                  runId={runId}
                  result={result}
                />
              ) : (
                <div className={styles.generating} role="status">
                  <span aria-hidden />
                  <p>The agent is assembling channel copy, evidence, and policy gates.</p>
                </div>
              )}

              {result ? (
                <div className={styles.result}>
                  <h3>Publication result</h3>
                  <pre>{JSON.stringify(result, null, 2)}</pre>
                </div>
              ) : null}

              {draft && currentStatus === "awaiting_approval" ? (
                <div className={styles.decision}>
                  <label className={styles.field}>
                    <span>Operator comment <small>optional</small></span>
                    <textarea
                      rows={3}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Revision note, rejection reason, or approval context…"
                    />
                  </label>
                  <label className={styles.acknowledgement}>
                    <input
                      type="checkbox"
                      checked={reviewAcknowledged}
                      onChange={(event) => {
                        setAcknowledgedDraftKey(event.target.checked ? displayedDraftKey : "");
                      }}
                      disabled={!displayedDraftKey || Boolean(busy)}
                    />
                    <span>
                      I reviewed this run&apos;s channel copy, evidence, disclosures,
                      and policy gates. For Substack, I am approving the exact source
                      and editor-body hashes shown in this run. I understand other
                      ready channels may publish immediately.
                    </span>
                  </label>
                  <div className={styles.decisionButtons}>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      onClick={() => void decide("reject")}
                      disabled={!canDecide}
                    >
                      {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      onClick={() => void decide("approve")}
                      disabled={!canApprove}
                    >
                      {busy === "approve" ? "Approving…" : "Approve publication"}
                    </button>
                  </div>
                  <p className={styles.hint}>
                    Approval releases only the adapters and policy modes reported as ready.
                    Substack publishing may still require its editor handoff.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <p className={styles.notice} aria-live="polite">{notice}</p>
    </div>
  );
}

function StatusChip({ ready, label }: { ready: boolean; label: string }): React.JSX.Element {
  return (
    <span className={styles.statusChip} data-ready={ready || undefined}>
      <span aria-hidden />
      {titleCase(label)}
    </span>
  );
}

function XApprovalPacketCopyControl({
  packet,
}: {
  packet: string;
}): React.JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const lifecycle = useRef({ active: true, requestGeneration: 0 });
  const currentPacket = useRef(packet);

  useEffect(
    () => mountXApprovalPacketCopyLifecycle(lifecycle.current),
    [],
  );

  const copyPacket = async (): Promise<void> => {
    const requestedPacket = packet;
    const requestedGeneration = ++lifecycle.current.requestGeneration;
    setCopyState("idle");
    const currentRequest = (): {
      packet: string;
      requestGeneration: number;
      active: boolean;
    } => ({
      packet: currentPacket.current,
      requestGeneration: lifecycle.current.requestGeneration,
      active: lifecycle.current.active,
    });
    try {
      const result = await writeCurrentXActivationApprovalPacket({
        packet: requestedPacket,
        clipboard: navigator.clipboard,
        requestGeneration: requestedGeneration,
        currentRequest,
      });
      if (result === "copied") setCopyState("copied");
    } catch {
      const current = currentRequest();
      if (xApprovalPacketCopyRequestIsCurrent({
        requestedPacket,
        currentPacket: current.packet,
        requestGeneration: requestedGeneration,
        currentRequestGeneration: current.requestGeneration,
        active: current.active,
      })) {
        setCopyState("error");
      }
    }
  };

  return (
    <section
      className={styles.xApprovalPacket}
      aria-labelledby="x-approval-packet"
    >
      <div>
        <div>
          <h3 id="x-approval-packet">Copyable approval packet</h3>
          <p>
            Scope, exact prompts and responses, caps, opt-out, privacy,
            identity, and external evidence checklist. Copying performs no
            provider write.
          </p>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => void copyPacket()}
        >
          {copyState === "copied" ? "Packet copied" : "Copy approval packet"}
        </button>
      </div>
      <p
        className={
          copyState === "error"
            ? styles.readinessEvidenceError
            : styles.readinessEvidenceText
        }
        aria-live="polite"
      >
        {copyState === "copied"
          ? "Approval packet copied. No configuration or provider state changed."
          : copyState === "error"
            ? "Clipboard access was unavailable. No configuration or provider state changed."
            : "DRAFT ONLY — copying does not enable or authorize automation."}
      </p>
      <details>
        <summary>Preview approval packet</summary>
        <pre>{packet}</pre>
      </details>
    </section>
  );
}

export function XActivationApprovalPanel({
  status,
}: {
  status: XActivationStatus | null;
}): React.JSX.Element {
  const rows = useMemo(() => status ? xActivationRows(status) : [], [status]);
  const packet = useMemo(
    () => status ? xActivationApprovalPacket(status) : "",
    [status],
  );

  return (
    <section className={styles.panel} aria-labelledby="x-activation-approval">
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.step}>X</span>
          <h2 id="x-activation-approval">X activation &amp; approval evidence</h2>
        </div>
        <StatusChip
          ready={false}
          label={status ? "owner approval required" : "invalid evidence"}
        />
      </div>
      <p className={styles.xActivationIntro}>
        Read-only operator evidence for the deterministic mention-response
        lane. This panel cannot enable ingestion, enable replies, post, reply,
        change provider settings, or establish external X approval.
      </p>

      {!status ? (
        <div className={styles.xActivationInvalid} role="alert">
          <strong>X activation evidence unavailable.</strong>
          <p>
            The private status response was missing, malformed, contradictory,
            or outside the bounded schema. The panel fails closed and makes no
            activation or readiness claim.
          </p>
        </div>
      ) : (
        <>
          <dl className={styles.xActivationSummary}>
            <div>
              <dt>Expected account</dt>
              <dd>
                {status.expectedAccountIdentity
                  ? "@" + status.expectedAccountIdentity.username
                    + " · account " + status.expectedAccountIdentity.accountId
                  : "Unavailable — activation gated"}
              </dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{status.automaticReplyScope}.</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>
                <a href={status.privacyUrl} target="_blank" rel="noreferrer">
                  Public X data-use notice
                </a>
              </dd>
            </div>
            <div>
              <dt>Snapshot evaluated</dt>
              <dd><time dateTime={status.evaluatedAt}>{status.evaluatedAt}</time></dd>
            </div>
          </dl>

          <div className={styles.readinessGrid}>
            {rows.map((item) => (
              <article className={styles.readinessCard} key={item.key}>
                <div>
                  <h3>{item.label}</h3>
                  <StatusChip ready={item.ready} label={item.state} />
                </div>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>

          <section
            className={styles.xActivationSection}
            aria-labelledby="x-activation-blockers"
          >
            <h3 id="x-activation-blockers">Server-reported blockers</h3>
            {status.automation.blockers.length ? (
              <ul className={styles.xActivationBlockers}>
                {status.automation.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <p>
                No server-configuration blocker is reported. Automated-label
                visibility, managing-account linkage, X approval evidence, and
                API credits still require external verification.
              </p>
            )}
          </section>

          <section
            className={styles.xActivationSection}
            aria-labelledby="x-template-registry"
          >
            <h3 id="x-template-registry">
              Exact deterministic prompt and response registry
            </h3>
            <p className={styles.xTemplateDigest}>
              Registry SHA-256: <code>{status.automation.templateRegistryDigest}</code>
            </p>
            <div className={styles.xTemplateList}>
              {status.templates.map((template) => (
                <article key={template.templateId}>
                  <h4>{template.templateId}</h4>
                  <div className={styles.xTemplatePrompts}>
                    <strong>Exact eligible prompts</strong>
                    <ul>
                      {template.prompts.map((prompt) => (
                        <li key={prompt}><code>{prompt}</code></li>
                      ))}
                    </ul>
                  </div>
                  <strong className={styles.xTemplateResponseLabel}>
                    Exact response
                  </strong>
                  <pre>{template.body}</pre>
                </article>
              ))}
            </div>
          </section>

          <section
            className={styles.xActivationSection}
            aria-labelledby="x-external-verification"
          >
            <h3 id="x-external-verification">External verification still required</h3>
            <ul className={styles.xExternalChecks}>
              <li>
                <strong>Automated label visibility and manager linkage:</strong>{" "}
                inspect the canonical{" "}
                <a href="https://x.com/0xzaps" target="_blank" rel="noreferrer">
                  @0xzaps profile
                </a>
                . The local configuration attestation is not provider proof.
              </li>
              <li>
                <strong>API credits and account-spend availability:</strong>{" "}
                inspect the X Developer Console before a controlled test. The
                private OpenZaps status endpoint cannot read or prove either.
              </li>
            </ul>
          </section>

          <XApprovalPacketCopyControl key={packet} packet={packet} />
        </>
      )}
    </section>
  );
}

export function LeadDeleteControls({
  leadId,
  expanded,
  busy,
  onToggle,
  onConfirm,
  onCancel,
}: {
  leadId: string;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const triggerId = leadDeleteTriggerId(leadId);
  const confirmationId = `${triggerId}-confirmation`;
  const cancel = (): void => {
    onCancel();
    window.setTimeout(() => {
      document.getElementById(triggerId)?.focus();
    }, 0);
  };

  return (
    <>
      <button
        id={triggerId}
        type="button"
        aria-controls={expanded ? confirmationId : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
        disabled={busy}
      >
        {expanded ? "Hide delete options" : "Delete"}
      </button>
      {expanded ? (
        <div
          className={styles.deleteConfirmation}
          id={confirmationId}
          role="group"
          aria-label="Permanent deletion confirmation"
        >
          <button
            type="button"
            data-danger
            onClick={onConfirm}
            disabled={busy}
          >
            Confirm permanent delete
          </button>
          <button type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}

export function SyndicationSkipControls({
  itemId,
  expanded,
  busy,
  submitting,
  onToggle,
  onConfirm,
  onCancel,
}: {
  itemId: string;
  expanded: boolean;
  busy: boolean;
  submitting: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const triggerId = syndicationSkipTriggerId(itemId);
  const confirmationId = `${triggerId}-confirmation`;
  const cancel = (): void => {
    onCancel();
    window.setTimeout(() => {
      document.getElementById(triggerId)?.focus();
    }, 0);
  };

  return (
    <>
      <button
        id={triggerId}
        type="button"
        data-danger
        aria-controls={expanded ? confirmationId : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
        disabled={busy}
      >
        {expanded ? "Hide skip options" : "Skip"}
      </button>
      {expanded ? (
        <div
          className={styles.deleteConfirmation}
          id={confirmationId}
          role="group"
          aria-label="Permanent syndication skip confirmation"
        >
          <button
            type="button"
            data-danger
            onClick={onConfirm}
            disabled={busy}
          >
            {submitting ? "Skipping…" : "Confirm permanent skip"}
          </button>
          <button type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}

function DraftReview({
  draft,
  operatorToken,
  runId,
  result,
}: {
  draft: unknown;
  operatorToken: string;
  runId: string;
  result: unknown;
}): React.JSX.Element {
  const record = isRecord(draft) ? draft : {};
  const channelEntries = extractChannelEntries(record);
  const sourcePacket = isRecord(record.sourcePacket) ? record.sourcePacket : null;
  const evidence = [
    ...(sourcePacket?.interaction
      ? [{ label: "Verified X reply target", ...sourcePacket.interaction }]
      : []),
    ...itemEntries(record.evidence ?? record.sources ?? sourcePacket?.facts),
  ];
  const gates = itemEntries(
    record.policyGates
    ?? record.policyDecisions
    ?? record.decisions
    ?? record.policy
    ?? record.gates
    ?? record.guardrails,
  );
  const headline = text(record.title) ?? text(record.topic);

  return (
    <div className={styles.review}>
      {headline ? <h3 className={styles.draftTitle}>{headline}</h3> : null}

      <div className={styles.copyGrid}>
        {channelEntries.length ? channelEntries.map(([channel, value]) => (
          <article
            className={`${styles.copyCard} ${
              channel === "substack" ? styles.substackCard : ""
            }`}
            key={`${channel}:${
              isRecord(value) ? text(value.id) ?? text(value.candidateId) ?? "draft" : "draft"
            }`}
          >
            <div>
              <h3>{channel === "x" ? "X" : titleCase(channel)}</h3>
              {channel === "substack" ? <span>editor handoff</span> : null}
            </div>
            {channel === "substack" ? (
              <SubstackHandoff
                candidateId={isRecord(value)
                  ? text(value.id) ?? text(value.candidateId) ?? ""
                  : ""}
                value={value}
                operatorToken={operatorToken}
                runId={runId}
                verificationEnabled={hasSubstackEditorHandoff(
                  result,
                  isRecord(value)
                    ? text(value.id) ?? text(value.candidateId) ?? ""
                    : "",
                )}
              />
            ) : (
              <DraftCopy value={value} />
            )}
          </article>
        )) : (
          <article className={styles.copyCard}>
            <div><h3>Draft payload</h3></div>
            <pre>{typeof draft === "string" ? draft : JSON.stringify(draft, null, 2)}</pre>
          </article>
        )}
      </div>

      <div className={styles.reviewMeta}>
        <ReviewItems title="Evidence" items={evidence} empty="No evidence was attached." />
        <ReviewItems title="Policy gates" items={gates} empty="No policy gates were reported." gates />
      </div>
    </div>
  );
}

export function SubstackPublicationReceipt({
  verification,
}: {
  verification: Extract<SubstackVerification, { persisted: true }>;
}): React.JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const copyManifestPatch = async (): Promise<void> => {
    setCopyState("idle");
    try {
      await writeSubstackManifestPatchClipboard(
        verification.manifestPatch,
        navigator.clipboard,
      );
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <section
      className={styles.substackPreview}
      aria-label="Immutable Substack publication receipt"
    >
      <span>Immutable publication receipt</span>
      <div className={styles.substackMeta}>
        <strong>
          {verification.receiptResult === "recorded"
            ? "RSS publication receipt recorded"
            : "Existing RSS publication receipt matched"}
        </strong>
        <p role="status">
          {verification.receiptResult === "recorded"
            ? "The exact public URL, approved title, and publication time are now durably recorded."
            : "The exact durable receipt was already present; no duplicate record was created."}
        </p>
        <small>
          Tutorial: <code>{verification.manifestEntry.id}</code>
          <br />
          Source: <code>{verification.manifestEntry.sourcePath}</code>
        </small>
      </div>
      <label className={styles.field}>
        <span>Exact manifest replacement object</span>
        <textarea
          aria-label="Exact tutorial manifest patch"
          readOnly
          rows={12}
          value={verification.manifestPatch}
        />
      </label>
      <div className={styles.substackActions}>
        <button type="button" onClick={() => void copyManifestPatch()}>
          {copyState === "copied"
            ? "Manifest patch copied"
            : "Copy exact manifest patch"}
        </button>
        <span role="status">
          {copyState === "error"
            ? "Clipboard access failed. Select the read-only patch above."
            : "Owner review is still required before changing the source-controlled manifest."}
        </span>
      </div>
      <small>
        Review this replacement object against <code>docs/tutorials/manifest.json</code>
        {" "}and commit it through the normal Git review. The verifier never edits
        Substack or repository files automatically.
      </small>
    </section>
  );
}

export function SubstackHandoff({
  candidateId,
  value,
  operatorToken,
  runId,
  verificationEnabled,
}: {
  candidateId: string;
  value: unknown;
  operatorToken: string;
  runId: string;
  verificationEnabled: boolean;
}): React.JSX.Element {
  const draft = substackDraftView(value);
  const [copyState, setCopyState] = useState<
    "idle" | "rich" | "plain" | "error"
  >(
    "idle",
  );
  const [canonicalUrl, setCanonicalUrl] = useState("");
  const [verification, setVerification] =
    useState<SubstackVerification | null>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const verificationGeneration = useRef(0);
  const canonicalUrlRef = useRef("");

  if (!draft) return <DraftCopy value={value} />;
  const richText = prepareSubstackRichText(draft.bodyMarkdown);
  const source = isRecord(value) ? value : null;
  const tutorialSourcePath = text(source?.sourcePath);
  const tutorialSourceSha256 = text(source?.sourceSha256);
  const tutorialBodySha256 = text(source?.bodySha256);

  const copyRichText = async (): Promise<void> => {
    setCopyState("idle");
    try {
      const copiedAs = await writeSubstackClipboard(
        richText,
        navigator.clipboard,
        typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
      );
      setCopyState(copiedAs);
    } catch {
      setCopyState("error");
    }
  };

  const verifyPublication = async (): Promise<void> => {
    const requestedCanonicalUrl = canonicalSubstackPostUrl(canonicalUrl);
    if (
      !verificationEnabled
      || verificationBusy
      || !requestedCanonicalUrl
      || !runId
      || !candidateId
    ) return;
    const requestGeneration = verificationGeneration.current + 1;
    verificationGeneration.current = requestGeneration;
    canonicalUrlRef.current = requestedCanonicalUrl;
    setCanonicalUrl(requestedCanonicalUrl);
    setVerificationBusy(true);
    setVerification(null);
    setVerificationError("");
    try {
      const body = await operatorRequest(
        "/api/marketing/substack/verify",
        operatorToken,
        {
          method: "POST",
          body: JSON.stringify({
            runId,
            candidateId,
            canonicalUrl: requestedCanonicalUrl,
          }),
        },
      );
      if (
        !substackVerificationResponseIsCurrent({
          requestGeneration,
          currentGeneration: verificationGeneration.current,
          requestedCanonicalUrl,
          currentRawUrl: canonicalUrlRef.current,
        })
      ) return;
      const parsed = parseSubstackVerification(body, {
        runId,
        candidateId,
        canonicalUrl: requestedCanonicalUrl,
        tutorialId: text(source?.tutorialId) ?? "",
        approvedTitle: draft.title,
        sourcePath: tutorialSourcePath ?? "",
      });
      if (!parsed) throw new Error("The RSS verifier returned an invalid receipt.");
      setVerification(parsed);
    } catch (error) {
      if (requestGeneration === verificationGeneration.current) {
        setVerificationError(
          error instanceof Error
            ? error.message
            : "The public RSS could not be verified.",
        );
      }
    } finally {
      if (requestGeneration === verificationGeneration.current) {
        setVerificationBusy(false);
      }
    }
  };

  return (
    <div className={styles.substackHandoff}>
      <div className={styles.substackMeta}>
        <span>Title</span>
        <strong>{draft.title}</strong>
        {draft.subtitle ? <p>{draft.subtitle}</p> : null}
        {draft.tags.length ? <small>{draft.tags.join(" · ")}</small> : null}
        {tutorialSourcePath ? <small>Source: {tutorialSourcePath}</small> : null}
        {tutorialSourceSha256 ? (
          <p>
            Source SHA-256<br />
            <code>{tutorialSourceSha256}</code>
          </p>
        ) : null}
        {tutorialBodySha256 ? (
          <p>
            Editor body SHA-256<br />
            <code>{tutorialBodySha256}</code>
          </p>
        ) : null}
      </div>

      {verificationEnabled ? (
        <div className={styles.substackActions}>
          <button type="button" onClick={() => void copyRichText()}>
            {copyState === "rich"
              ? "Rich text copied"
              : copyState === "plain"
                ? "Plain text copied"
                : "Copy rich text"}
          </button>
          <a
            href="https://defitutorials.substack.com/publish/post"
            target="_blank"
            rel="noreferrer noopener"
          >
            Open official editor ↗
          </a>
          <span role="status">
            {copyState === "error"
              ? "Clipboard access failed. Select the plain-text fallback below."
              : copyState === "plain"
                ? "Rich copy was unavailable, so the plain-text body was copied."
                : "Copies the body as text/html plus a plain-text fallback."}
          </span>
        </div>
      ) : (
        <p className={styles.hint}>
          Approve this exact draft before using the official editor handoff.
        </p>
      )}

      <section className={styles.substackPreview} aria-label="Rendered Substack body preview">
        <span>Rendered preview</span>
        {/* prepareSubstackRichText escapes raw HTML and allowlists every href. */}
        <div dangerouslySetInnerHTML={{ __html: richText.html }} />
      </section>

      <details className={styles.plainTextFallback}>
        <summary>Selectable plain-text editor fallback</summary>
        <pre>{richText.plainText}</pre>
      </details>

      <details className={styles.markdownAudit}>
        <summary>Reviewed Markdown audit source</summary>
        <pre>{draft.bodyMarkdown}</pre>
      </details>

      {verificationEnabled ? (
        <>
          <div className={styles.substackVerify}>
            <label className={styles.field}>
              <span>Published canonical URL</span>
              <input
                type="url"
                inputMode="url"
                spellCheck={false}
                value={canonicalUrl}
                onChange={(event) => {
                  verificationGeneration.current += 1;
                  canonicalUrlRef.current = event.target.value;
                  setCanonicalUrl(event.target.value);
                  setVerification(null);
                  setVerificationError("");
                  setVerificationBusy(false);
                }}
                placeholder="https://defitutorials.substack.com/p/..."
              />
            </label>
            <button
              type="button"
              onClick={() => void verifyPublication()}
              disabled={
                verificationBusy
                || !canonicalUrl.trim()
                || !runId
                || !candidateId
              }
            >
              {verificationBusy ? "Checking RSS…" : "Verify public RSS"}
            </button>
            {verification ? (
              <p data-status={verification.status} role="status">
                {verification.status === "rss_confirmed"
                  ? `RSS confirmed the exact URL and approved title · ${
                      new Date(verification.publishedAt).toLocaleString()
                    }.`
                  : verification.status === "title_mismatch"
                    ? "The URL is in the feed, but its title does not match the approved draft."
                    : "The exact URL is not present in the public feed."}
              </p>
            ) : null}
            {verificationError ? <p role="status">{verificationError}</p> : null}
            <small>
              The verifier reads public RSS and never publishes or edits Substack.
              On an exact match it stores an immutable evidence receipt and prepares
              a manifest replacement object; an owner must still review and commit
              that source-controlled change.
            </small>
          </div>
          {verification?.persisted ? (
            <SubstackPublicationReceipt verification={verification} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function extractChannelEntries(record: JsonRecord): Array<[Channel, unknown]> {
  if (Array.isArray(record.candidates)) {
    const presentations = Array.isArray(record.presentations) ? record.presentations : [];
    const entries = record.candidates.flatMap((value): Array<[Channel, unknown]> => {
      if (!isRecord(value)) return [];
      const channel = text(value.channel);
      if (!CHANNELS.includes(channel as Channel)) return [];
      const candidateId = text(value.id);
      const presentation = presentations.find((item) =>
        isRecord(item) && text(item.candidateId) === candidateId
      );
      const tutorialHandoff = channel === "substack" && isRecord(record.tutorialHandoff)
        ? record.tutorialHandoff
        : null;
      return [[
        channel as Channel,
        {
          ...value,
          ...(presentation && isRecord(presentation) ? presentation : {}),
          ...(tutorialHandoff ?? {}),
        },
      ]];
    });
    if (entries.length) return entries;
  }

  const candidates = [
    record.channels,
    record.copy,
    record.outputs,
    record.content,
    record,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      const entries = CHANNELS
        .filter((channel) => candidate[channel] !== undefined)
        .map((channel) => [channel, candidate[channel]] as [Channel, unknown]);
      if (entries.length) return entries;
    }
    if (Array.isArray(candidate)) {
      const entries = candidate.flatMap((value): Array<[Channel, unknown]> => {
        if (!isRecord(value)) return [];
        const channel = text(value.channel);
        return CHANNELS.includes(channel as Channel)
          ? [[channel as Channel, value]]
          : [];
      });
      if (entries.length) return entries;
    }
  }
  return [];
}

function DraftCopy({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === "string") return <pre>{value}</pre>;
  if (!isRecord(value)) return <pre>{JSON.stringify(value, null, 2)}</pre>;

  const fields = ["title", "subtitle", "text", "copy", "content", "body", "bodyMarkdown"] as const;
  const parts = fields.flatMap((field) => {
    const valueText = text(value[field]);
    return valueText ? [{ field, value: valueText }] : [];
  });
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
    : [];

  if (!parts.length && !tags.length) return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return (
    <>
      {parts.map((part) => (
        <div className={styles.copyPart} key={part.field}>
          {part.field !== "text" && part.field !== "copy" && part.field !== "content"
            ? <span>{titleCase(part.field)}</span>
            : null}
          <pre>{part.value}</pre>
        </div>
      ))}
      {tags.length ? (
        <div className={styles.copyPart}>
          <span>Tags</span>
          <pre>{tags.join(", ")}</pre>
        </div>
      ) : null}
    </>
  );
}

function itemEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) =>
      isRecord(entry) ? { key, ...entry } : { key, value: entry },
    );
  }
  return value === undefined || value === null ? [] : [value];
}

function ReviewItems({
  title,
  items,
  empty,
  gates = false,
}: {
  title: string;
  items: unknown[];
  empty: string;
  gates?: boolean;
}): React.JSX.Element {
  return (
    <section className={styles.reviewList}>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => {
            if (typeof item === "string") return <li key={`${item}-${index}`}>{item}</li>;
            if (!isRecord(item)) return <li key={index}>{JSON.stringify(item)}</li>;

            const label =
              text(item.label)
              ?? text(item.title)
              ?? text(item.claim)
              ?? text(item.fact)
              ?? text(item.candidateId)
              ?? text(item.key)
              ?? `Item ${index + 1}`;
            const detail =
              (gates ? policyGateDetail(item) : null)
              ?? text(item.detail)
              ?? text(item.reason)
              ?? text(item.message)
              ?? scalarEvidenceDetail(item)
              ?? text(item.status);
            const href = text(item.url) ?? text(item.sourceUrl) ?? text(item.href);
            const gateDisposition = text(item.disposition)?.toLowerCase() ?? "";
            const gateReady =
              item.passed === true
              || item.ready === true
              || ["allow", "dry_run"].includes(gateDisposition)
              || ["pass", "passed", "ready", "allowed"].includes(text(item.status)?.toLowerCase() ?? "");
            const gatePending = gateDisposition === "require_approval";

            return (
              <li key={`${label}-${index}`}>
                {gates ? (
                  <span
                    className={styles.gateDot}
                    data-ready={gateReady || undefined}
                    data-pending={gatePending || undefined}
                    aria-hidden
                  />
                ) : null}
                <div>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">{label}</a>
                  ) : (
                    <strong>{label}</strong>
                  )}
                  {detail && detail !== label ? <p>{detail}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>{empty}</p>
      )}
    </section>
  );
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "Unavailable";
  return null;
}

function scalarEvidenceDetail(item: JsonRecord): string | null {
  const value = scalarText(item.value);
  const status = text(item.status);
  if (value && status) return `${value} · ${titleCase(status)}`;
  return value ?? status;
}

function policyGateDetail(item: JsonRecord): string | null {
  const parts: string[] = [];
  const disposition = text(item.disposition) ?? text(item.status);
  if (disposition) parts.push(titleCase(disposition));

  const approvalReasons = stringArray(item.approvalReasons);
  if (approvalReasons.length) parts.push(`Approval: ${approvalReasons.map(titleCase).join(", ")}`);

  const disclosures = stringArray(item.requiredDisclosures);
  if (disclosures.length) parts.push(`Disclosures: ${disclosures.map(titleCase).join(", ")}`);

  if (Array.isArray(item.issues)) {
    const issues = item.issues.flatMap((issue) => {
      if (typeof issue === "string") return issue.trim() ? [issue.trim()] : [];
      if (!isRecord(issue)) return [];
      const message = text(issue.message) ?? text(issue.code);
      return message ? [message] : [];
    });
    if (issues.length) parts.push(`Issues: ${issues.join(" ")}`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}
