import type {
  MarketingCandidate,
  MarketingDailyCounters,
  MarketingDisclosure,
  MarketingPolicyContext,
  MarketingPolicyDecision,
  MarketingPolicyIssue,
  MarketingRiskTier,
  MarketingRunState,
  MarketingTopic,
} from "@/lib/marketing/types";
import { MARKETING_POLICY_VERSION } from "@/lib/marketing/types";
import {
  isReviewedMarketingCampaignCandidate,
  reviewedMarketingCampaignIsAvailable,
} from "@/lib/marketing/scheduled-template";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";

export const PRE_AUDIT_DISCLOSURE = "Pre-audit software. Verify before use.";
export const UNAVAILABLE_DATA_DISCLOSURE = "Unavailable means unknown, not zero.";
export const MAX_MARKETING_SOURCE_AGE_MS = 6 * 60 * 60 * 1_000;
export const MAX_VOLATILE_MARKETING_SOURCE_AGE_MS = 30 * 1_000;
const MAX_MARKETING_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_VOLATILE_MARKETING_CLOCK_SKEW_MS = 5 * 1_000;

const VOLATILE_SOURCE_FACT_KEYS = new Set([
  "product.virtual_trading_markets",
  "product.virtual_trading_quote",
  "product.request_a_zap_intake",
  "product.agent_kit_sdk_release",
  "product.agent_kit_mcp_release",
  "product.agent_kit_boundaries",
]);

export const CANONICAL_OUTBOUND_HOSTS = [
  "www.0xzaps.com",
  "0xzaps.com",
  "defitutorials.substack.com",
  "github.com/0pen-Zaps/openzaps",
] as const;

const APPROVAL_TOPICS = new Set<MarketingTopic>([
  "incident",
  "security",
  "token",
  "trading",
  "partnership",
  "roadmap",
  "new_deployment",
]);

const SENSITIVE_TOPICS = new Set<MarketingTopic>(["incident", "security", "token", "trading"]);

const PROHIBITED_FLAG_MESSAGES: ReadonlyArray<[
  keyof MarketingCandidate["flags"],
  string,
  string,
]> = [
  ["containsCredential", "credential_exposure", "Content contains or exposes a credential."],
  ["guaranteesReturns", "guaranteed_returns", "Guaranteed-return or risk-free financial claims are prohibited."],
  ["impersonatesPerson", "impersonation", "Impersonating a person or organization is prohibited."],
  ["requestsPolicyBypass", "policy_bypass", "Content attempts to bypass marketing policy or approval."],
  ["unsolicitedBulkMessaging", "unsolicited_bulk", "Unsolicited bulk messaging is prohibited."],
  ["usesUnavailableAsZero", "unavailable_as_zero", "Unavailable data cannot be represented as zero."],
];

const RUN_TRANSITIONS: Readonly<Record<MarketingRunState, readonly MarketingRunState[]>> = {
  queued: ["drafting", "blocked", "failed"],
  drafting: ["policy_check", "blocked", "failed"],
  policy_check: [
    "auto_authorized",
    "awaiting_approval",
    "approved",
    "blocked",
    "dry_run_complete",
    "failed",
  ],
  auto_authorized: ["publishing", "blocked", "failed"],
  awaiting_approval: ["approved", "rejected", "blocked", "failed"],
  approved: ["publishing", "rejected", "blocked", "failed"],
  publishing: ["published", "failed", "blocked"],
  published: [],
  rejected: [],
  blocked: [],
  failed: ["policy_check", "blocked"],
  dry_run_complete: [],
};

export function canTransitionMarketingRun(from: MarketingRunState, to: MarketingRunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isCanonicalOutboundUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;

    const hostname = url.hostname.toLowerCase();
    if (hostname === "www.0xzaps.com" || hostname === "0xzaps.com" || hostname === "defitutorials.substack.com") {
      return true;
    }
    if (hostname !== "github.com") return false;

    const normalizedPath = url.pathname.replace(/\/+$/, "").toLowerCase();
    return (
      normalizedPath === "/0pen-zaps/openzaps" ||
      normalizedPath.startsWith("/0pen-zaps/openzaps/")
    );
  } catch {
    return false;
  }
}

export function requiredMarketingDisclosures(candidate: MarketingCandidate): MarketingDisclosure[] {
  const required = new Set<MarketingDisclosure>();
  if (candidate.sourcePacket.protocolPreAudit && candidate.action !== "draft") required.add("pre_audit");
  const citedFactKeys = new Set(
    candidate.claims
      .filter((claim) => claim.treatment !== "omitted")
      .flatMap((claim) => claim.factKeys),
  );
  if (
    candidate.sourcePacket.facts.some(
      (fact) => fact.status === "unavailable" && citedFactKeys.has(fact.key),
    )
  ) {
    required.add("unavailable_not_zero");
  }
  return [...required];
}

export function classifyMarketingRisk(candidate: MarketingCandidate): MarketingRiskTier {
  if (
    hasProhibitedFlag(candidate) ||
    containsProhibitedText(candidate) ||
    hasInvalidUnavailableValue(candidate) ||
    outboundUrls(candidate).some((url) => !isCanonicalOutboundUrl(url)) ||
    nonCanonicalCandidateLinkLikeTargets(candidate).length > 0
  ) {
    return 4;
  }
  if (candidate.action === "draft") return 0;
  if (
    candidate.action === "direct_message" ||
    candidate.topics.some((topic) => SENSITIVE_TOPICS.has(topic)) ||
    candidate.kind === "incident_update"
  ) {
    return 3;
  }
  if (
    candidate.kind === "tutorial" ||
    candidate.action === "prepare_tutorial" ||
    candidate.action === "publish_tutorial" ||
    candidate.topics.some((topic) => APPROVAL_TOPICS.has(topic))
  ) {
    return 2;
  }
  return 1;
}

export function evaluateMarketingPolicy(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
): MarketingPolicyDecision {
  const riskTier = classifyMarketingRisk(candidate);
  const issues: MarketingPolicyIssue[] = [];
  const automaticallyAuthorized = isBoundedAutoPublishAuthorized(
    candidate,
    context,
    riskTier,
  );
  const approvalReasons = approvalReasonsFor(candidate, automaticallyAuthorized);
  const requiredDisclosures = requiredMarketingDisclosures(candidate);
  const dailyCounter = dailyCounterFor(candidate);

  addProhibitedFlagIssues(candidate, issues);
  addProhibitedTextIssues(candidate, issues);
  addOutboundLinkIssues(candidate, issues);
  addSourceAndClaimIssues(candidate, issues);
  addSourceFreshnessIssues(candidate, context, issues);
  addDisclosureIssues(candidate, requiredDisclosures, issues);
  addReplyIssues(candidate, context, issues);
  addUsageIssues(candidate, context, dailyCounter, issues);

  if (riskTier === 4) {
    return decision("prohibited");
  }

  if (issues.length > 0) {
    return decision("blocked");
  }

  if (!context.config.enabled || !context.config.readiness.configurationValid) {
    issues.push({ code: "configuration_unready", message: "Marketing configuration is disabled or invalid." });
    return decision("blocked");
  }

  if (!context.config.readiness.canDraft) {
    issues.push({ code: "drafting_unready", message: "Marketing drafting is not ready." });
    return decision("blocked");
  }

  if (context.config.dryRun || candidate.action === "draft") {
    return decision("dry_run");
  }

  if (!context.config.readiness.durableLedgerConfigured) {
    issues.push({
      code: "durable_ledger_required",
      message: "Reviewed delivery requires the durable usage and idempotency ledger.",
    });
    return decision("blocked");
  }

  const channelIssue = channelReadinessIssue(candidate, context);
  if (channelIssue) {
    issues.push(channelIssue);
    return decision("blocked");
  }

  if (approvalReasons.length > 0 && !context.humanApproved) {
    return decision("require_approval");
  }

  return decision("allow");

  function decision(disposition: MarketingPolicyDecision["disposition"]): MarketingPolicyDecision {
    return {
      policyVersion: MARKETING_POLICY_VERSION,
      candidateId: candidate.id,
      riskTier,
      disposition,
      approvalRequired: approvalReasons.length > 0,
      approvalReasons,
      requiredDisclosures,
      dailyCounter,
      issues,
      evaluatedAt: context.now,
    };
  }
}

export function isBoundedAutoPublishAuthorized(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
  riskTier: MarketingRiskTier = classifyMarketingRisk(candidate),
): boolean {
  const authorization = context.automaticAuthorization;
  return (
    authorization?.kind === "scheduled_template" &&
    context.config.autoPublish &&
    context.config.readiness.autoPublishReady &&
    !context.humanApproved &&
    riskTier === 1 &&
    candidate.action === "broadcast" &&
    (candidate.channel === "x" || candidate.channel === "discord") &&
    reviewedMarketingCampaignIsAvailable(
      authorization.templateId,
      candidate.channel,
      context.now,
    ) &&
    isReviewedMarketingCampaignCandidate(
      candidate,
      authorization.templateId,
    )
  );
}

function hasProhibitedFlag(candidate: MarketingCandidate): boolean {
  return PROHIBITED_FLAG_MESSAGES.some(([flag]) => candidate.flags[flag]);
}

function containsProhibitedText(candidate: MarketingCandidate): boolean {
  const rendered = [candidate.body, ...candidate.links].join("\n");
  return (
    containsCredentialLikeData(rendered) ||
    /\b(?:guaranteed returns?|risk[- ]free returns?|cannot lose)\b/iu.test(candidate.body)
  );
}

function hasInvalidUnavailableValue(candidate: MarketingCandidate): boolean {
  return candidate.sourcePacket.facts.some((fact) => fact.status === "unavailable" && fact.value !== null);
}

function addProhibitedFlagIssues(candidate: MarketingCandidate, issues: MarketingPolicyIssue[]): void {
  for (const [flag, code, message] of PROHIBITED_FLAG_MESSAGES) {
    if (candidate.flags[flag]) issues.push({ code, message });
  }
}

function addProhibitedTextIssues(candidate: MarketingCandidate, issues: MarketingPolicyIssue[]): void {
  if (containsCredentialLikeData([candidate.body, ...candidate.links].join("\n"))) {
    issues.push({ code: "credential_exposure", message: "Content contains what appears to be an API credential." });
  }
  if (/\b(?:guaranteed returns?|risk[- ]free returns?|cannot lose)\b/iu.test(candidate.body)) {
    issues.push({
      code: "guaranteed_returns",
      message: "Guaranteed-return or risk-free financial claims are prohibited.",
    });
  }
}

function outboundUrls(candidate: MarketingCandidate): string[] {
  return [...new Set([...candidate.links, ...extractAbsoluteUrls(candidate.body)])];
}

function extractAbsoluteUrls(body: string): string[] {
  const matches = body.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  return matches.map((url) => url.replace(/[),.;!?\]}]+$/u, ""));
}

function addOutboundLinkIssues(candidate: MarketingCandidate, issues: MarketingPolicyIssue[]): void {
  for (const url of outboundUrls(candidate)) {
    if (!isCanonicalOutboundUrl(url)) {
      issues.push({ code: "outbound_url_not_allowlisted", message: `Outbound URL is not canonical: ${url}` });
    }
  }
  for (const target of nonCanonicalCandidateLinkLikeTargets(candidate)) {
    issues.push({
      code: "link_syntax_not_canonical",
      message: `Link-like target is not an approved canonical destination: ${target}`,
    });
  }
}

function trimLinkPunctuation(value: string): string {
  return value.replace(/[),.;!?\]}]+$/u, "");
}

/**
 * Catch link forms URL-only scanning misses: protocol-relative targets,
 * Markdown schemes, and bare/linkified domains. Numeric dotted versions such
 * as v1.2.3 do not match the domain rule.
 */
function nonCanonicalLinkLikeTargets(body: string): string[] {
  const rejected = new Set<string>();
  const protocolRelative =
    /(?:^|[\s([<{])((?:\/\/)[^\s<>()\[\]{}]+)/giu;
  for (const match of body.matchAll(protocolRelative)) {
    if (match[1]) rejected.add(trimLinkPunctuation(match[1]));
  }

  const markdownDestination = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of body.matchAll(markdownDestination)) {
    const destination = trimLinkPunctuation(match[1] ?? "");
    if (!destination || destination.startsWith("/") || destination.startsWith("#")) continue;
    if (/^https:\/\//iu.test(destination)) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(destination) || destination.startsWith("//")) {
      rejected.add(destination);
    }
  }

  const bareDomain =
    /(?:^|[\s([<{])((?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>()\[\]{}]*)?)(?![a-z0-9_-])/giu;
  for (const match of body.matchAll(bareDomain)) {
    const target = trimLinkPunctuation(match[1] ?? "");
    if (!target) continue;
    try {
      if (!isCanonicalOutboundUrl(`https://${target}`)) rejected.add(target);
    } catch {
      rejected.add(target);
    }
  }
  return [...rejected];
}

function nonCanonicalCandidateLinkLikeTargets(
  candidate: MarketingCandidate,
): string[] {
  const sourceFactKeys = new Set(
    candidate.sourcePacket.facts.map((fact) => fact.key.toLowerCase()),
  );
  // Internally supplied fact keys can be dot-delimited (for example,
  // authority.execution) but are evidence identifiers, not destinations.
  return nonCanonicalLinkLikeTargets(candidate.body).filter(
    (target) => !sourceFactKeys.has(target.toLowerCase()),
  );
}

function addSourceAndClaimIssues(candidate: MarketingCandidate, issues: MarketingPolicyIssue[]): void {
  const facts = new Map(candidate.sourcePacket.facts.map((fact) => [fact.key, fact]));

  for (const fact of candidate.sourcePacket.facts) {
    if (fact.status === "unavailable" && fact.value !== null) {
      issues.push({
        code: "invalid_unavailable_fact",
        message: `Unavailable fact ${fact.key} must carry null, not a stand-in value.`,
      });
    }
  }

  for (const claim of candidate.claims) {
    if (claim.treatment !== "omitted" && claim.factKeys.length === 0) {
      issues.push({ code: "unsupported_claim", message: `Claim has no cited fact: ${claim.text}` });
      continue;
    }
    for (const factKey of claim.factKeys) {
      const fact = facts.get(factKey);
      if (!fact) {
        issues.push({ code: "unknown_fact", message: `Claim cites unknown fact key: ${factKey}` });
      } else if (claim.treatment === "asserted" && fact.status !== "confirmed") {
        issues.push({
          code: "unconfirmed_claim_asserted",
          message: `Claim asserts ${factKey}, but the source status is ${fact.status}.`,
        });
      }
    }
  }
}

function addSourceFreshnessIssues(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
  issues: MarketingPolicyIssue[],
): void {
  const evaluatedAt = Date.parse(context.now);
  const createdAt = Date.parse(candidate.sourcePacket.createdAt);
  const age = evaluatedAt - createdAt;
  if (
    !Number.isFinite(evaluatedAt)
    || !Number.isFinite(createdAt)
    || age > MAX_MARKETING_SOURCE_AGE_MS
    || age < -MAX_MARKETING_CLOCK_SKEW_MS
  ) {
    issues.push({
      code: "source_packet_stale",
      message:
      "Source evidence is outside the six-hour approval window; create a fresh draft.",
    });
  }

  if (
    context.automaticAuthorization?.kind === "scheduled_template"
    && !context.humanApproved
  ) {
    const citedFactKeys = new Set(
      candidate.claims
        .filter((claim) => claim.treatment !== "omitted")
        .flatMap((claim) => claim.factKeys),
    );
    const volatileEvidenceStale = candidate.sourcePacket.facts.some((fact) => {
      if (
        !VOLATILE_SOURCE_FACT_KEYS.has(fact.key)
        || !citedFactKeys.has(fact.key)
      ) {
        return false;
      }
      const observedAt = Date.parse(fact.observedAt);
      const factAge = evaluatedAt - observedAt;
      return !Number.isFinite(evaluatedAt)
        || !Number.isFinite(observedAt)
        || factAge > MAX_VOLATILE_MARKETING_SOURCE_AGE_MS
        || factAge < -MAX_VOLATILE_MARKETING_CLOCK_SKEW_MS;
    });
    if (volatileEvidenceStale) {
      issues.push({
        code: "volatile_source_stale",
        message:
          "Live capability evidence is outside the 30-second automatic-delivery window; collect it again before publishing.",
      });
    }
  }
}

function addDisclosureIssues(
  candidate: MarketingCandidate,
  required: readonly MarketingDisclosure[],
  issues: MarketingPolicyIssue[],
): void {
  const body = candidate.body.toLowerCase();
  for (const disclosure of required) {
    if (!candidate.disclosures.includes(disclosure)) {
      issues.push({ code: "missing_disclosure_marker", message: `Missing required disclosure: ${disclosure}.` });
      continue;
    }

    const text = disclosure === "pre_audit" ? PRE_AUDIT_DISCLOSURE : UNAVAILABLE_DATA_DISCLOSURE;
    if (!body.includes(text.toLowerCase())) {
      issues.push({ code: "missing_disclosure_text", message: `Rendered content is missing: ${text}` });
    }
  }
}

function addReplyIssues(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
  issues: MarketingPolicyIssue[],
): void {
  if (candidate.channel !== "x" || candidate.action !== "reply") return;

  if (!context.config.dryRun && !context.config.xAiReplyApproved) {
    issues.push({
      code: "x_ai_reply_approval_missing",
      message: "AI-authored X replies are disabled in this release.",
    });
  }
  if (!candidate.interaction) {
    issues.push({
      code: "x_reply_not_explicitly_summoned",
      message: "X replies require verified metadata for an explicit mention or owned quote.",
    });
  }
  if (
    candidate.interaction
    && JSON.stringify(candidate.interaction) !== JSON.stringify(candidate.sourcePacket.interaction)
  ) {
    issues.push({
      code: "x_reply_verification_mismatch",
      message: "X reply verification evidence does not match the immutable source packet.",
    });
  }
  if (
    candidate.interaction &&
    context.repliedInteractionIds.includes(candidate.interaction.id)
  ) {
    issues.push({
      code: "x_interaction_already_replied",
      message: "Only one automated reply is allowed per X interaction.",
    });
  }
}

function addUsageIssues(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
  dailyCounter: keyof MarketingDailyCounters | null,
  issues: MarketingPolicyIssue[],
): void {
  if (!dailyCounter) return;

  const today = isoDay(context.now);
  if (!today || context.usage.day !== today) {
    issues.push({
      code: "daily_usage_window_invalid",
      message: "Daily usage must be supplied for the current UTC day.",
    });
    return;
  }

  if (context.usage.counts[dailyCounter] >= context.config.dailyCaps[dailyCounter]) {
    issues.push({
      code: "daily_cap_reached",
      message: `Daily cap reached for ${dailyCounter}.`,
    });
  }
}

function isoDay(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function approvalReasonsFor(
  candidate: MarketingCandidate,
  automaticallyAuthorized: boolean,
): string[] {
  const reasons = new Set<string>();
  if (candidate.action !== "draft" && !automaticallyAuthorized) {
    reasons.add("every_run_human_approval");
  }
  if (candidate.kind === "tutorial" || ["prepare_tutorial", "publish_tutorial"].includes(candidate.action)) {
    reasons.add("tutorial");
  }
  for (const topic of candidate.topics) {
    if (APPROVAL_TOPICS.has(topic)) reasons.add(topic);
  }
  if (candidate.kind === "incident_update") reasons.add("incident");
  if (candidate.action === "direct_message") reasons.add("direct_message");
  return [...reasons];
}

function dailyCounterFor(candidate: MarketingCandidate): keyof MarketingDailyCounters | null {
  if (candidate.action === "direct_message") return "directMessages";
  if (candidate.channel === "x" && candidate.action === "reply") return "xReplies";
  if (candidate.channel === "x" && candidate.action === "broadcast") return "xPosts";
  if (candidate.channel === "discord" && ["broadcast", "reply"].includes(candidate.action)) return "discordPosts";
  if (
    candidate.channel === "substack" &&
    ["prepare_tutorial", "publish_tutorial"].includes(candidate.action)
  ) {
    return "substackTutorials";
  }
  return null;
}

function channelReadinessIssue(
  candidate: MarketingCandidate,
  context: MarketingPolicyContext,
): MarketingPolicyIssue | null {
  if (candidate.action === "draft" || candidate.action === "prepare_tutorial") return null;

  if (candidate.action === "direct_message") {
    return {
      code: "direct_messages_unsupported",
      message: "Direct-message delivery has no deployed marketing adapter.",
    };
  }
  if (candidate.channel === "discord" && candidate.action === "reply") {
    return {
      code: "discord_replies_unsupported",
      message: "Discord replies are supported only through deterministic slash commands.",
    };
  }

  const channels = context.config.readiness.channels;
  if (candidate.channel === "x" && !channels.x) {
    return { code: "x_not_ready", message: "X credentials are not configured." };
  }
  if (candidate.channel === "discord" && candidate.action === "broadcast" && !channels.discordBroadcast) {
    return { code: "discord_broadcast_not_ready", message: "Discord broadcast credentials are not configured." };
  }
  if (candidate.channel === "discord" && ["reply", "direct_message"].includes(candidate.action) && !channels.discordInteractions) {
    return { code: "discord_interactions_not_ready", message: "Discord interaction credentials are not configured." };
  }
  if (candidate.channel === "substack" && candidate.action === "publish_tutorial") {
    return {
      code: "substack_direct_publish_unsupported",
      message: "Substack has no supported write API; use the human-approved manual handoff.",
    };
  }
  if (candidate.channel === "substack") {
    return {
      code: "substack_action_unsupported",
      message: "Only tutorial preparation is supported for Substack.",
    };
  }
  if (candidate.channel === "farcaster" && !channels.farcaster) {
    return { code: "farcaster_not_ready", message: "No reviewed Farcaster publishing adapter is configured." };
  }
  if (candidate.channel === "github" && !channels.github) {
    return { code: "github_not_ready", message: "No reviewed GitHub publishing adapter is configured." };
  }
  return null;
}
