"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  marketingRunIdFromSearch,
  parseMarketingSourceUrls,
} from "@/lib/marketing/operator-input";
import {
  canonicalSubstackPostUrl,
  prepareSubstackRichText,
  substackDraftView,
  type SubstackRichText,
} from "@/lib/marketing/substack-handoff";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";
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

type SubstackVerification = {
  runId: string;
  candidateId: string;
  status: "rss_confirmed" | "not_found" | "title_mismatch";
  canonicalUrl: string;
  approvedTitle: string;
  feedUrl: string;
  checkedAt: string;
  publishedAt?: string;
  persisted: false;
};

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
  expected: { runId: string; candidateId: string; canonicalUrl: string },
): SubstackVerification | null {
  const runId = text(body.runId);
  const candidateId = text(body.candidateId);
  const status = text(body.status);
  const canonicalUrl = text(body.canonicalUrl);
  const approvedTitle = text(body.approvedTitle);
  const feedUrl = text(body.feedUrl);
  const checkedAt = text(body.checkedAt);
  const publishedAt = text(body.publishedAt);
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
    || body.persisted !== false
    || (publishedAt !== null && !Number.isFinite(Date.parse(publishedAt)))
  ) return null;
  return {
    runId,
    candidateId,
    status: status as SubstackVerification["status"],
    canonicalUrl,
    approvedTitle,
    feedUrl,
    checkedAt,
    ...(publishedAt ? { publishedAt } : {}),
    persisted: false,
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
  const leadSessionGeneration = useRef(0);
  const leadActionGeneration = useRef(0);
  const syndicationRequestGeneration = useRef(0);
  const xIdentityRequestGeneration = useRef(0);
  const discordPreflightRequestGeneration = useRef(0);

  const readiness = useMemo(() => readinessRows(status), [status]);
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
      setLeads(operatorLeads(body));
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
      await loadLeadQueue(leadToken, leadScoreFloor, sessionGeneration);
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
      await loadLeadQueue(leadToken, leadScoreFloor, sessionGeneration);
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
                  onClick={() => void loadLeadQueue(leadToken, leadScoreFloor)}
                  disabled={
                    leadQueueState === "loading" || Boolean(leadActionId)
                  }
                >
                  {leadQueueState === "loading" ? "Loading…" : "Refresh"}
                </button>
              </div>
            </div>

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
                {leads.map((lead) => (
                  <article className={styles.leadCard} key={lead.id}>
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
                      {text(lead.attribution.utmSource) ? (
                        <span>Source: {text(lead.attribution.utmSource)}</span>
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
                ))}
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
                ? `RSS confirmed the exact URL and approved title${
                    verification.publishedAt
                      ? ` · ${new Date(verification.publishedAt).toLocaleString()}`
                      : ""
                  }.`
                : verification.status === "title_mismatch"
                  ? "The URL is in the feed, but its title does not match the approved draft."
                  : "The exact URL is not present in the public feed."}
            </p>
          ) : null}
          {verificationError ? <p role="status">{verificationError}</p> : null}
          <small>
            This is a read-only check. It does not publish, edit Substack, or
            persist an RSS-confirmed receipt; the current ledger records only
            the approved editor handoff.
          </small>
        </div>
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
