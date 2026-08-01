/**
 * Serializable marketing-domain contracts.
 *
 * Keep these types free of Date, bigint, Map, Set, functions, and SDK classes:
 * workflow runs and channel adapters must be able to persist them as JSON.
 */

export const MARKETING_POLICY_VERSION = 2 as const;

/**
 * Versioned, server-rendered copy whose exact public fields are checked again
 * immediately before any automatic provider write.
 */
export const SCHEDULED_MARKETING_TEMPLATE_ID =
  "virtual-trading-request-zap-v2" as const;

export const MARKETING_RUN_STATES = [
  "queued",
  "drafting",
  "policy_check",
  "auto_authorized",
  "awaiting_approval",
  "approved",
  "publishing",
  "published",
  "rejected",
  "blocked",
  "failed",
  "dry_run_complete",
] as const;

export type MarketingRunState = (typeof MARKETING_RUN_STATES)[number];

export const MARKETING_RISK_TIERS = [0, 1, 2, 3, 4] as const;

/**
 * 0: internal draft only
 * 1: low-risk, source-backed public content
 * 2: material announcement that always needs approval
 * 3: sensitive financial, security, or private-channel content
 * 4: prohibited; approval can never override it
 */
export type MarketingRiskTier = (typeof MARKETING_RISK_TIERS)[number];

export const MARKETING_CHANNELS = ["x", "discord", "substack", "farcaster", "github"] as const;

export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

export const MARKETING_ACTIONS = [
  "draft",
  "broadcast",
  "reply",
  "direct_message",
  "prepare_tutorial",
  "publish_tutorial",
] as const;

export type MarketingAction = (typeof MARKETING_ACTIONS)[number];

export const MARKETING_CONTENT_KINDS = [
  "product_update",
  "community_reply",
  "tutorial",
  "incident_update",
  "release_note",
  "educational",
  "other",
] as const;

export type MarketingContentKind = (typeof MARKETING_CONTENT_KINDS)[number];

export const MARKETING_TOPICS = [
  "general",
  "protocol",
  "simulation",
  "incident",
  "security",
  "token",
  "trading",
  "partnership",
  "roadmap",
  "new_deployment",
] as const;

export type MarketingTopic = (typeof MARKETING_TOPICS)[number];

export const MARKETING_DISCLOSURES = ["pre_audit", "unavailable_not_zero"] as const;

export type MarketingDisclosure = (typeof MARKETING_DISCLOSURES)[number];

export const MARKETING_FACT_STATUSES = ["confirmed", "inference", "unavailable"] as const;

export type MarketingFactStatus = (typeof MARKETING_FACT_STATUSES)[number];

export type MarketingScalar = string | number | boolean | null;

export interface MarketingFact {
  /** Stable key used by claims to cite this fact. */
  key: string;
  label: string;
  /** Unavailable facts must carry null, never a fabricated zero. */
  value: MarketingScalar;
  status: MarketingFactStatus;
  sourceUrl: string;
  observedAt: string;
}

export interface MarketingExternalData {
  id: string;
  sourceUrl: string;
  observedAt: string;
  content: string;
  /** Always false: text fetched from outside OpenZaps can supply facts, never instructions. */
  instructionsTrusted: false;
  handling: "data_only";
}

export interface MarketingSourcePacket {
  id: string;
  createdAt: string;
  protocolPreAudit: boolean;
  facts: MarketingFact[];
  externalData: MarketingExternalData[];
  /**
   * Immutable, metadata-only evidence returned by X's user-context API.
   * The target post text is intentionally never stored in workflow state.
   */
  interaction: MarketingInteraction | null;
}

export interface MarketingClaim {
  text: string;
  /** Every asserted or qualified claim must point to at least one fact key. */
  factKeys: string[];
  treatment: "asserted" | "qualified" | "omitted";
}

export interface MarketingInteraction {
  id: string;
  targetUrl: string;
  authorId: string;
  authenticatedAccountId: string;
  trigger: "mention" | "quote";
  observedAt: string;
}

export interface MarketingPolicyFlags {
  containsCredential: boolean;
  guaranteesReturns: boolean;
  impersonatesPerson: boolean;
  requestsPolicyBypass: boolean;
  unsolicitedBulkMessaging: boolean;
  usesUnavailableAsZero: boolean;
}

export interface MarketingCandidate {
  id: string;
  channel: MarketingChannel;
  action: MarketingAction;
  kind: MarketingContentKind;
  topics: MarketingTopic[];
  body: string;
  /** Explicit links; policy also scans absolute URLs embedded in body. */
  links: string[];
  disclosures: MarketingDisclosure[];
  claims: MarketingClaim[];
  sourcePacket: MarketingSourcePacket;
  interaction: MarketingInteraction | null;
  flags: MarketingPolicyFlags;
}

export interface MarketingDailyCounters {
  xPosts: number;
  xReplies: number;
  discordPosts: number;
  substackTutorials: number;
  directMessages: number;
}

export interface MarketingDailyUsage {
  /** UTC date in YYYY-MM-DD. A stale/malformed window fails closed. */
  day: string;
  counts: MarketingDailyCounters;
}

export type MarketingDailyCaps = MarketingDailyCounters;

export type MarketingMode = "disabled" | "dry_run" | "review_only" | "live";

export interface MarketingChannelReadiness {
  x: boolean;
  discordBroadcast: boolean;
  discordInteractions: boolean;
  /** No direct-message adapter is deployed in this release. */
  directMessages: false;
  /** False until Substack offers a supported write API. */
  substackDirectPublish: false;
  substackManualHandoff: true;
  /** Reserved for future reviewed adapters; never inferred from a generic token. */
  farcaster: false;
  github: false;
}

export interface MarketingReadiness {
  configurationValid: boolean;
  canDraft: boolean;
  /** True only when a durable cross-run usage and idempotency ledger is explicitly configured. */
  durableLedgerConfigured: boolean;
  /** True only for the bounded, source-reviewed scheduled-campaign surface. */
  autoPublishReady: boolean;
  channels: MarketingChannelReadiness;
  blockers: string[];
}

/**
 * Contains no credential values and is safe to persist with workflow state or
 * return from an authenticated readiness endpoint.
 */
export interface MarketingConfig {
  enabled: boolean;
  dryRun: boolean;
  /** Operator intent before the durable-ledger safety gate is applied. */
  autoPublishRequested: boolean;
  /** Effective only for server-controlled deterministic reviewed campaigns. */
  autoPublish: boolean;
  /** Effective only when both independent X attestations are true. */
  xAiReplyApproved: boolean;
  xAutomatedLabelConfirmed: boolean;
  mode: MarketingMode;
  dailyCaps: MarketingDailyCaps;
  readiness: MarketingReadiness;
}

export interface MarketingPolicyContext {
  /** Evaluation time, serialized as ISO-8601. */
  now: string;
  config: MarketingConfig;
  usage: MarketingDailyUsage;
  /** A separate human approval record; never inferred from content. */
  humanApproved: boolean;
  /**
   * Server-created authority for one exact deterministic campaign. Public
   * drafting inputs cannot request or construct this authorization.
   */
  automaticAuthorization?: {
    kind: "scheduled_template";
    templateId: string;
  };
  /** Durable ledger entries prevent retry/replay from producing a second reply. */
  repliedInteractionIds: string[];
}

export type MarketingPolicyDisposition =
  | "allow"
  | "require_approval"
  | "dry_run"
  | "blocked"
  | "prohibited";

export interface MarketingPolicyIssue {
  code: string;
  message: string;
}

export interface MarketingPolicyDecision {
  policyVersion: typeof MARKETING_POLICY_VERSION;
  candidateId: string;
  riskTier: MarketingRiskTier;
  disposition: MarketingPolicyDisposition;
  approvalRequired: boolean;
  approvalReasons: string[];
  requiredDisclosures: MarketingDisclosure[];
  dailyCounter: keyof MarketingDailyCounters | null;
  issues: MarketingPolicyIssue[];
  evaluatedAt: string;
}

export interface MarketingSourcePacketInput {
  id: string;
  createdAt: string;
  protocolPreAudit: boolean;
  facts: MarketingFact[];
  interaction?: MarketingInteraction | null;
  externalData?: Array<{
    id: string;
    sourceUrl: string;
    observedAt: string;
    content: string;
  }>;
}
