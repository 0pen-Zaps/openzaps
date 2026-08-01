import "server-only";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import {
  fetchSubstackFeed,
  type SubstackFeedResult,
} from "@/lib/marketing/channels/substack";
import {
  CONFIRMED_TUTORIAL_BASELINE_URLS,
  normalizeApprovedOpenZapsFeedItems,
  normalizeSubstackFeedPosts,
  type SyndicationClassification,
  type SyndicationItem,
  type SyndicationSource,
} from "@/lib/marketing/syndication";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import { canonicalSubstackPostUrl } from "@/lib/marketing/substack-handoff";
import { readBoundedJsonBody } from "@/lib/request-body";

const CURSOR_RPC = "get_marketing_syndication_source_cursor";
const DISCOVER_RPC = "discover_marketing_syndication_items";
const LIST_RPC = "list_marketing_syndication_items";
const CLAIM_RPC = "claim_marketing_syndication_draft";
const ATTACH_RPC = "attach_marketing_syndication_workflow";
const FAIL_RPC = "fail_marketing_syndication_draft";
const SKIP_RPC = "skip_marketing_syndication_item";
const SYNC_RPC = "sync_marketing_syndication_item";

const MAX_RPC_RESPONSE_BYTES = 256 * 1_024;
const RPC_TIMEOUT_MS = 12_000;
const ITEM_ID = /^[0-9a-f]{64}$/u;
const ITEM_KEY = ITEM_ID;
const RUN_ID = /^[^\s/\\]{1,200}$/u;
const MAX_DISCOVERY_ITEMS = 100;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

export type MarketingSyndicationStatus =
  | "baseline"
  | "pending"
  | "drafting"
  | "awaiting_approval"
  | "published"
  | "failed"
  | "skipped";

export interface MarketingSyndicationItem {
  itemId: string;
  source: SyndicationSource;
  title: string;
  canonicalUrl: string;
  publishedAt: string | null;
  classification: SyndicationClassification;
  status: MarketingSyndicationStatus;
  campaignSlug: string;
  workflowRunId: string | null;
  discoveredAt: string;
  updatedAt: string;
}

export interface MarketingSyndicationDiscoverySourceResult {
  source: SyndicationSource;
  result:
    | "initialized"
    | "discovered"
    | "not_modified"
    | "already_initialized"
    | "baseline_required";
  discoveredCount: number;
  baselineCount: number;
  pendingCount: number;
  existingCount: number;
  checkedAt: string | null;
}

export interface MarketingSyndicationDiscoveryResult {
  sources: MarketingSyndicationDiscoverySourceResult[];
  discoveredCount: number;
  pendingCount: number;
  providerWritesAttempted: false;
  workflowsStarted: false;
}

export interface MarketingSyndicationClaim {
  result:
    | "claimed"
    | "already_drafted"
    | "already_claimed"
    | "not_found"
    | "not_draftable";
  item: MarketingSyndicationDraftItem | null;
}

export type MarketingSyndicationDraftItem = Omit<
  MarketingSyndicationItem,
  "discoveredAt" | "updatedAt"
>;

export interface MarketingSyndicationMutation {
  result:
    | "attached"
    | "already_attached"
    | "already_completed"
    | "workflow_conflict"
    | "not_claimed"
    | "not_claimable"
    | "failed"
    | "already_failed"
    | "skipped"
    | "already_skipped"
    | "in_progress"
    | "synced"
    | "already_synced"
    | "not_found"
    | "invalid_transition";
  status: MarketingSyndicationStatus | null;
  workflowRunId: string | null;
}

export type MarketingSyndicationSyncStatus =
  | "awaiting_approval"
  | "published"
  | "failed";

export type MarketingSyndicationErrorCode =
  | "not_configured"
  | "invalid_input"
  | "network_error"
  | "rpc_error"
  | "invalid_response";

export class MarketingSyndicationError extends Error {
  constructor(
    readonly code: MarketingSyndicationErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketingSyndicationError";
  }
}

interface SyndicationDependencies {
  env?: Environment;
  fetchImpl?: Fetch;
}

interface RpcConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

interface SourceCursor {
  source: SyndicationSource;
  initializedAt: string | null;
  etag: string | null;
  lastModified: string | null;
  checkedAt: string | null;
}

interface DiscoverySnapshot {
  source_key: SyndicationSource;
  etag: string | null;
  last_modified: string | null;
  not_modified: boolean;
  items: Array<{
    source_item_key: string;
    canonical_url: string;
    title: string;
    published_at: string | null;
    classification: "tutorial" | "product_update" | "unknown";
    campaign_slug: string;
  }>;
}

function hasSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

function configuration(env: Environment): RpcConfiguration | null {
  if (env.OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED !== "true") return null;
  if (!hasSecret(env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const rawUrl = env.SUPABASE_URL;
  if (
    !rawUrl
    || !isMarketingLedgerSupabaseUrl(
      rawUrl,
      env.OPENZAPS_MARKETING_SUPABASE_PROJECT_REF,
      env.NODE_ENV !== "production",
    )
  ) return null;

  try {
    const base = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
    return {
      restUrl: new URL("rest/v1/", base).toString(),
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    };
  } catch {
    return null;
  }
}

export function marketingSyndicationConfigured(
  env: Environment = process.env,
): boolean {
  return configuration(env) !== null;
}

function requireConfiguration(env: Environment): RpcConfiguration {
  const configured = configuration(env);
  if (!configured) {
    throw new MarketingSyndicationError(
      "not_configured",
      "The durable marketing syndication inbox is not configured.",
    );
  }
  return configured;
}

async function callRpc(
  name:
    | typeof CURSOR_RPC
    | typeof DISCOVER_RPC
    | typeof LIST_RPC
    | typeof CLAIM_RPC
    | typeof ATTACH_RPC
    | typeof FAIL_RPC
    | typeof SKIP_RPC
    | typeof SYNC_RPC,
  body: Record<string, unknown>,
  dependencies: SyndicationDependencies,
): Promise<unknown> {
  const configured = requireConfiguration(dependencies.env ?? process.env);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL(`rpc/${name}`, configured.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configured.serviceRoleKey,
          authorization: `Bearer ${configured.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new MarketingSyndicationError(
      "network_error",
      "The durable marketing syndication inbox could not be reached.",
    );
  }
  if (!response.ok) {
    throw new MarketingSyndicationError(
      "rpc_error",
      `The durable marketing syndication inbox rejected the request (${response.status}).`,
      response.status,
    );
  }
  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid response.",
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid response.",
    );
  }
  const row = record(value[0]);
  if (!row) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid response.",
    );
  }
  return row;
}

function timestamp(value: unknown, nullable = false): string | null | undefined {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function boundedNullable(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string"
    && value.length <= max
    && !/[\r\n]/u.test(value)
    && !containsCredentialLikeData(value)
    ? value
    : undefined;
}

function count(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(number) && Number(number) >= 0
    ? Number(number)
    : undefined;
}

function source(value: unknown): SyndicationSource | undefined {
  return value === "openzaps" || value === "defitutorials" ? value : undefined;
}

function status(value: unknown): MarketingSyndicationStatus | undefined {
  return [
    "baseline",
    "pending",
    "drafting",
    "awaiting_approval",
    "published",
    "failed",
    "skipped",
  ].includes(String(value))
    ? value as MarketingSyndicationStatus
    : undefined;
}

function canonicalUrl(value: unknown, itemSource: SyndicationSource): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  if (itemSource === "defitutorials") {
    return canonicalSubstackPostUrl(value) === value ? value : undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.0xzaps.com"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseItem(value: unknown): MarketingSyndicationItem | null {
  const row = record(value);
  if (!row || typeof row.item_id !== "string" || !ITEM_ID.test(row.item_id)) return null;
  const itemSource = source(row.source_key);
  const itemStatus = status(row.state);
  if (!itemSource || !itemStatus) return null;
  const url = canonicalUrl(row.canonical_url, itemSource);
  const title = typeof row.title === "string"
    ? row.title.trim().replace(/\s+/gu, " ")
    : "";
  const publishedAt = timestamp(row.source_published_at, true);
  const discoveredAt = timestamp(row.discovered_at);
  const updatedAt = timestamp(row.state_changed_at);
  const runId = boundedNullable(row.workflow_run_id, 200);
  const databaseClassification = row.classification;
  const classification: SyndicationClassification | undefined =
    databaseClassification === "unknown"
      ? "needs_classification"
      : databaseClassification === "tutorial" || databaseClassification === "product_update"
        ? "reviewable"
        : undefined;
  const slug = typeof row.campaign_slug === "string"
    && /^[a-z0-9][a-z0-9-]{0,95}$/u.test(row.campaign_slug)
    ? row.campaign_slug
    : undefined;

  if (
    !url
    || !title
    || Array.from(title).length > 200
    || containsCredentialLikeData(title)
    || publishedAt === undefined
    || !discoveredAt
    || !updatedAt
    || runId === undefined
    || (runId !== null && !RUN_ID.test(runId))
    || !classification
    || !slug
    || (databaseClassification === "tutorial" && itemSource !== "defitutorials")
    || (databaseClassification === "product_update" && itemSource !== "openzaps")
    || (classification === "reviewable" && publishedAt === null)
    || (["baseline", "pending", "skipped"].includes(itemStatus)
      && runId !== null)
    || (["awaiting_approval", "published"].includes(itemStatus)
      && runId === null)
  ) return null;

  return {
    itemId: row.item_id,
    source: itemSource,
    title,
    canonicalUrl: url,
    publishedAt,
    classification,
    status: itemStatus,
    campaignSlug: slug,
    workflowRunId: runId,
    discoveredAt,
    updatedAt,
  };
}

function parseDraftItem(value: unknown): MarketingSyndicationDraftItem | null {
  const row = record(value);
  if (!row || typeof row.item_id !== "string" || !ITEM_ID.test(row.item_id)) return null;
  const itemSource = source(row.source_key);
  const itemStatus = status(row.state);
  if (!itemSource || !itemStatus) return null;
  const url = canonicalUrl(row.canonical_url, itemSource);
  const title = typeof row.title === "string"
    ? row.title.trim().replace(/\s+/gu, " ")
    : "";
  const publishedAt = timestamp(row.source_published_at, true);
  const runId = boundedNullable(row.workflow_run_id, 200);
  const databaseClassification = row.classification;
  const classification: SyndicationClassification | undefined =
    databaseClassification === "unknown"
      ? "needs_classification"
      : databaseClassification === "tutorial" || databaseClassification === "product_update"
        ? "reviewable"
        : undefined;
  const slug = typeof row.campaign_slug === "string"
    && /^[a-z0-9][a-z0-9-]{0,95}$/u.test(row.campaign_slug)
    ? row.campaign_slug
    : undefined;
  if (
    !url
    || !title
    || Array.from(title).length > 200
    || containsCredentialLikeData(title)
    || publishedAt === undefined
    || runId === undefined
    || (runId !== null && !RUN_ID.test(runId))
    || !classification
    || !slug
    || (databaseClassification === "tutorial" && itemSource !== "defitutorials")
    || (databaseClassification === "product_update" && itemSource !== "openzaps")
    || (classification === "reviewable" && publishedAt === null)
    || (["baseline", "pending", "skipped"].includes(itemStatus)
      && runId !== null)
    || (["awaiting_approval", "published"].includes(itemStatus)
      && runId === null)
  ) return null;
  return {
    itemId: row.item_id,
    source: itemSource,
    title,
    canonicalUrl: url,
    publishedAt,
    classification,
    status: itemStatus,
    campaignSlug: slug,
    workflowRunId: runId,
  };
}

async function getCursor(
  requestedSource: SyndicationSource,
  dependencies: SyndicationDependencies,
): Promise<SourceCursor> {
  const row = oneRow(await callRpc(
    CURSOR_RPC,
    { p_source_key: requestedSource },
    dependencies,
  ));
  if (row.result_code !== "found" && row.result_code !== "not_initialized") {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid cursor.",
    );
  }
  const rowSource = source(row.source_key);
  const initializedAt = timestamp(row.initialized_at, true);
  const etag = boundedNullable(row.etag, 512);
  const lastModified = boundedNullable(row.last_modified, 128);
  const checkedAt = timestamp(row.last_checked_at, true);
  if (
    rowSource !== requestedSource
    || initializedAt === undefined
    || etag === undefined
    || lastModified === undefined
    || checkedAt === undefined
    || (lastModified !== null && !Number.isFinite(Date.parse(lastModified)))
    || (row.result_code === "not_initialized"
      && (initializedAt !== null || etag !== null || lastModified !== null || checkedAt !== null))
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid cursor.",
    );
  }
  return {
    source: requestedSource,
    initializedAt,
    etag,
    lastModified,
    checkedAt,
  };
}

function databaseClassification(
  item: SyndicationItem,
): "tutorial" | "product_update" | "unknown" {
  if (!item.draftable) return "unknown";
  return item.source === "defitutorials" ? "tutorial" : "product_update";
}

function snapshot(
  requestedSource: SyndicationSource,
  items: readonly SyndicationItem[],
  validators: { etag: string | null; lastModified: string | null },
  notModified: boolean,
): DiscoverySnapshot {
  if (items.length > MAX_DISCOVERY_ITEMS || (notModified && items.length > 0)) {
    throw new MarketingSyndicationError(
      "invalid_input",
      "The syndication discovery snapshot is invalid.",
    );
  }
  return {
    source_key: requestedSource,
    etag: validators.etag,
    last_modified: validators.lastModified,
    not_modified: notModified,
    items: items.map((item) => {
      if (item.source !== requestedSource || !ITEM_KEY.test(item.key)) {
        throw new MarketingSyndicationError(
          "invalid_input",
          "The syndication discovery snapshot is invalid.",
        );
      }
      return {
        source_item_key: item.key,
        canonical_url: item.canonicalUrl,
        title: item.title,
        published_at: item.publishedAt,
        classification: databaseClassification(item),
        campaign_slug: item.campaignSlug,
      };
    }),
  };
}

async function persistSnapshot(
  sourceCursor: SourceCursor,
  sourceSnapshot: DiscoverySnapshot,
  dependencies: SyndicationDependencies,
): Promise<MarketingSyndicationDiscoverySourceResult> {
  if (
    sourceCursor.initializedAt === null
    && !sourceSnapshot.not_modified
    && sourceSnapshot.items.length === 0
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "A non-empty complete snapshot is required before syndication can be baselined.",
    );
  }
  const row = oneRow(await callRpc(
    DISCOVER_RPC,
    {
      p_snapshot: sourceSnapshot,
      p_initialize_as_baseline:
        !sourceSnapshot.not_modified && sourceCursor.initializedAt === null,
    },
    dependencies,
  ));
  const result = row.result_code;
  if (![
    "baselined",
    "discovered",
    "not_modified",
    "already_initialized",
    "baseline_required",
  ].includes(String(result))) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid discovery result.",
    );
  }
  const rowSource = source(row.source_key);
  const initializedAt = timestamp(row.initialized_at, true);
  const discoveredCount = count(row.discovered_count);
  const baselineCount = count(row.baseline_count);
  const pendingCount = count(row.pending_count);
  const existingCount = count(row.existing_count);
  const checkedAt = timestamp(row.last_checked_at, true);
  if (
    rowSource !== sourceCursor.source
    || initializedAt === undefined
    || discoveredCount === undefined
    || baselineCount === undefined
    || pendingCount === undefined
    || existingCount === undefined
    || checkedAt === undefined
    || (result === "not_modified"
      && (discoveredCount !== 0 || baselineCount !== 0))
    || (result === "baseline_required"
      && (baselineCount !== 0 || pendingCount !== 0 || existingCount !== 0))
    || (result === "baseline_required"
      ? initializedAt !== null
      : initializedAt === null || checkedAt === null)
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid discovery result.",
    );
  }
  return {
    source: sourceCursor.source,
    result: result === "baselined"
      ? "initialized"
      : result as MarketingSyndicationDiscoverySourceResult["result"],
    discoveredCount,
    baselineCount,
    pendingCount,
    existingCount,
    checkedAt,
  };
}

async function persistSnapshotWithFreshBaseline(
  sourceCursor: SourceCursor,
  sourceSnapshot: DiscoverySnapshot,
  dependencies: SyndicationDependencies,
): Promise<MarketingSyndicationDiscoverySourceResult> {
  const first = await persistSnapshot(sourceCursor, sourceSnapshot, dependencies);
  if (first.result !== "baseline_required") return first;

  const freshCursor = await getCursor(sourceCursor.source, dependencies);
  if (sourceSnapshot.not_modified && freshCursor.initializedAt === null) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "A complete feed snapshot is required before syndication can be baselined.",
    );
  }
  return persistSnapshot(freshCursor, sourceSnapshot, dependencies);
}

function validators(
  feed: SubstackFeedResult,
  cursor: SourceCursor,
): { etag: string | null; lastModified: string | null } {
  const rawEtag = feed.etag ?? (feed.notModified ? cursor.etag : null);
  const rawLastModified =
    feed.lastModified ?? (feed.notModified ? cursor.lastModified : null);
  const etag = boundedNullable(rawEtag, 512);
  const lastModified = boundedNullable(rawLastModified, 128);
  if (
    etag === undefined
    || lastModified === undefined
    || (lastModified !== null && !Number.isFinite(Date.parse(lastModified)))
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The tutorial feed returned invalid cache validators.",
    );
  }
  return {
    etag,
    lastModified,
  };
}

/**
 * Discover public metadata only. This function cannot call any provider write
 * adapter or start a workflow. The database decides whether a successful first
 * snapshot is a baseline and admits only later items as pending.
 */
export async function discoverMarketingSyndication(
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationDiscoveryResult> {
  const openZapsCursor = await getCursor("openzaps", dependencies);
  const openZapsItems = normalizeApprovedOpenZapsFeedItems();
  const openZaps = await persistSnapshotWithFreshBaseline(
    openZapsCursor,
    snapshot(
      "openzaps",
      openZapsItems,
      { etag: null, lastModified: null },
      false,
    ),
    dependencies,
  );

  const tutorialsCursor = await getCursor("defitutorials", dependencies);
  const feed = await fetchSubstackFeed(
    {
      idempotencyKey: "syndication:defitutorials-feed",
      ...(tutorialsCursor.etag ? { etag: tutorialsCursor.etag } : {}),
      ...(tutorialsCursor.lastModified
        ? { lastModified: tutorialsCursor.lastModified }
        : {}),
    },
    dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {},
  );
  if (feed.notModified && tutorialsCursor.initializedAt === null) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The tutorial feed returned not-modified before a baseline existed.",
    );
  }
  const tutorialItems = feed.notModified
    ? []
    : normalizeSubstackFeedPosts(feed.posts);
  if (!feed.notModified && tutorialItems.length === 0) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The tutorial feed returned an empty successful snapshot.",
    );
  }
  if (
    tutorialsCursor.initializedAt === null
    && !feed.notModified
    && CONFIRMED_TUTORIAL_BASELINE_URLS.some(
        (url) => !tutorialItems.some(
          (item) => item.canonicalUrl === url
            && item.classification === "reviewable",
        ),
      )
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The tutorial feed did not contain the complete approved baseline.",
    );
  }
  const tutorials = await persistSnapshotWithFreshBaseline(
    tutorialsCursor,
    snapshot(
      "defitutorials",
      tutorialItems,
      validators(feed, tutorialsCursor),
      feed.notModified,
    ),
    dependencies,
  );
  const sources = [openZaps, tutorials];
  return {
    sources,
    discoveredCount: sources.reduce(
      (total, item) => total + item.discoveredCount,
      0,
    ),
    pendingCount: sources.reduce(
      (total, item) => total + item.pendingCount,
      0,
    ),
    providerWritesAttempted: false,
    workflowsStarted: false,
  };
}

export async function listMarketingSyndicationItems(
  limit = 20,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationItem[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new MarketingSyndicationError(
      "invalid_input",
      "Syndication list limit must be between 1 and 50.",
    );
  }
  const value = await callRpc(LIST_RPC, { p_limit: limit }, dependencies);
  if (!Array.isArray(value) || value.length > limit) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid list.",
    );
  }
  const items = value.map(parseItem);
  if (items.some((item) => item === null)) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid item.",
    );
  }
  return items as MarketingSyndicationItem[];
}

function validItemId(itemId: string): boolean {
  return ITEM_ID.test(itemId);
}

export async function claimMarketingSyndicationDraft(
  itemId: string,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationClaim> {
  if (!validItemId(itemId)) {
    throw new MarketingSyndicationError("invalid_input", "Syndication item id is invalid.");
  }
  const row = oneRow(await callRpc(CLAIM_RPC, { p_item_id: itemId }, dependencies));
  const result = row.result_code;
  if (![
    "claimed",
    "already_completed",
    "already_claimed",
    "not_found",
    "unknown_classification",
    "failed",
    "not_claimable",
  ].includes(String(result))) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid claim.",
    );
  }
  const item = result === "not_found" ? null : parseDraftItem(row);
  const publicResult: MarketingSyndicationClaim["result"] =
    result === "already_completed"
      || (result === "already_claimed" && item?.workflowRunId)
      ? "already_drafted"
      : result === "unknown_classification" || result === "failed" || result === "not_claimable"
        ? "not_draftable"
        : result as MarketingSyndicationClaim["result"];
  if (
    (result !== "not_found" && !item)
    || (result !== "not_found" && row.item_id !== itemId)
    || (result === "not_found" && item !== null)
    || (result === "claimed" && item?.status !== "drafting")
    || (result === "already_completed" && !item?.workflowRunId)
    || (result === "claimed" && item?.workflowRunId !== null)
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an inconsistent claim.",
    );
  }
  return {
    result: publicResult,
    item,
  };
}

function parseMutation(
  value: unknown,
  allowed: readonly MarketingSyndicationMutation["result"][],
  itemId: string,
): MarketingSyndicationMutation {
  const row = oneRow(value);
  const result = row.result_code;
  const resultingStatus = row.state === null
    ? null
    : status(row.state);
  const runId = boundedNullable(row.workflow_run_id, 200);
  const changedAt = timestamp(row.state_changed_at, true);
  if (
    row.item_id !== itemId
    ||
    !allowed.includes(result as MarketingSyndicationMutation["result"])
    || resultingStatus === undefined
    || runId === undefined
    || changedAt === undefined
    || (runId !== null && !RUN_ID.test(runId))
    || (result === "not_found"
      ? resultingStatus !== null || runId !== null || changedAt !== null
      : resultingStatus === null || changedAt === null)
  ) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an invalid mutation result.",
    );
  }
  return {
    result: result as MarketingSyndicationMutation["result"],
    status: resultingStatus,
    workflowRunId: runId,
  };
}

export async function attachMarketingSyndicationWorkflow(
  itemId: string,
  workflowRunId: string,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationMutation> {
  if (!validItemId(itemId) || !RUN_ID.test(workflowRunId)) {
    throw new MarketingSyndicationError("invalid_input", "Syndication workflow attachment is invalid.");
  }
  const mutation = parseMutation(
    await callRpc(
      ATTACH_RPC,
      { p_item_id: itemId, p_workflow_run_id: workflowRunId },
      dependencies,
    ),
    [
      "attached",
      "already_attached",
      "workflow_conflict",
      "not_claimed",
      "not_claimable",
      "not_found",
    ],
    itemId,
  );
  const consistent =
    mutation.result === "attached"
      ? mutation.status === "drafting"
        && mutation.workflowRunId === workflowRunId
      : mutation.result === "already_attached"
        ? ["drafting", "awaiting_approval", "published", "failed"].includes(
            mutation.status ?? "",
          ) && mutation.workflowRunId === workflowRunId
        : mutation.result === "workflow_conflict"
          ? mutation.workflowRunId !== null
            && mutation.workflowRunId !== workflowRunId
          : mutation.result === "not_claimed"
            ? mutation.status === "pending" && mutation.workflowRunId === null
            : mutation.result === "not_found"
              ? mutation.status === null && mutation.workflowRunId === null
              : mutation.status !== null;
  if (!consistent) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an inconsistent workflow attachment.",
    );
  }
  return mutation;
}

export async function failMarketingSyndicationDraft(
  itemId: string,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationMutation> {
  if (!validItemId(itemId)) {
    throw new MarketingSyndicationError("invalid_input", "Syndication item id is invalid.");
  }
  const mutation = parseMutation(
    await callRpc(FAIL_RPC, { p_item_id: itemId }, dependencies),
    [
      "failed",
      "already_failed",
      "already_completed",
      "not_claimed",
      "not_claimable",
      "not_found",
    ],
    itemId,
  );
  const consistent =
    mutation.result === "failed" || mutation.result === "already_failed"
      ? mutation.status === "failed"
      : mutation.result === "already_completed"
        ? ["awaiting_approval", "published"].includes(mutation.status ?? "")
          && mutation.workflowRunId !== null
        : mutation.result === "not_claimed"
          ? mutation.status === "pending" && mutation.workflowRunId === null
          : mutation.result === "not_found"
            ? mutation.status === null && mutation.workflowRunId === null
            : mutation.status !== null;
  if (!consistent) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an inconsistent failure result.",
    );
  }
  return mutation;
}

export async function skipMarketingSyndicationItem(
  itemId: string,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationMutation> {
  if (!validItemId(itemId)) {
    throw new MarketingSyndicationError("invalid_input", "Syndication item id is invalid.");
  }
  const mutation = parseMutation(
    await callRpc(SKIP_RPC, { p_item_id: itemId }, dependencies),
    ["skipped", "already_skipped", "in_progress", "not_claimable", "not_found"],
    itemId,
  );
  const consistent =
    mutation.result === "skipped" || mutation.result === "already_skipped"
      ? mutation.status === "skipped" && mutation.workflowRunId === null
      : mutation.result === "in_progress"
        ? mutation.status === "drafting"
        : mutation.result === "not_found"
          ? mutation.status === null && mutation.workflowRunId === null
          : mutation.status !== null;
  if (!consistent) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an inconsistent skip result.",
    );
  }
  return mutation;
}

export async function syncMarketingSyndicationStatus(
  itemId: string,
  workflowRunId: string,
  nextStatus: MarketingSyndicationSyncStatus,
  dependencies: SyndicationDependencies = {},
): Promise<MarketingSyndicationMutation> {
  if (!validItemId(itemId) || !RUN_ID.test(workflowRunId)) {
    throw new MarketingSyndicationError("invalid_input", "Syndication status sync is invalid.");
  }
  const mutation = parseMutation(
    await callRpc(
      SYNC_RPC,
      {
        p_item_id: itemId,
        p_workflow_run_id: workflowRunId,
        p_state: nextStatus,
      },
      dependencies,
    ),
    [
      "synced",
      "already_synced",
      "workflow_conflict",
      "invalid_transition",
      "not_found",
    ],
    itemId,
  );
  const consistent =
    mutation.result === "synced" || mutation.result === "already_synced"
      ? mutation.status === nextStatus
        && mutation.workflowRunId === workflowRunId
      : mutation.result === "workflow_conflict"
        ? mutation.workflowRunId !== null
          && mutation.workflowRunId !== workflowRunId
        : mutation.result === "not_found"
          ? mutation.status === null && mutation.workflowRunId === null
          : mutation.status !== null;
  if (!consistent) {
    throw new MarketingSyndicationError(
      "invalid_response",
      "The durable marketing syndication inbox returned an inconsistent workflow sync.",
    );
  }
  return mutation;
}
