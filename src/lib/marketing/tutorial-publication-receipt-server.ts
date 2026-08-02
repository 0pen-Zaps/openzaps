import "server-only";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import { containsCredentialLikeData } from "@/lib/marketing/source-url";
import {
  canonicalSubstackPostUrl,
  normalizeSubstackTitle,
} from "@/lib/marketing/substack-handoff";
import { readBoundedJsonBody } from "@/lib/request-body";

const RECEIPT_RPC = "record_marketing_tutorial_publication_receipt";
const DEFITUTORIALS_FEED_URL = "https://defitutorials.substack.com/feed";
const MAX_RPC_RESPONSE_BYTES = 32 * 1_024;
const RPC_TIMEOUT_MS = 12_000;
const TUTORIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

export interface TutorialPublicationReceiptInput {
  tutorialId: string;
  runId: string;
  candidateId: string;
  sourcePath: string;
  sourceSha256: string;
  bodySha256: string;
  approvedTitle: string;
  canonicalUrl: string;
  feedUrl: string;
  publishedAt: string;
  rssCheckedAt: string;
}

export interface TutorialPublicationReceipt {
  result: "recorded" | "already_recorded";
  tutorialId: string;
  runId: string;
  candidateId: string;
  sourcePath: string;
  sourceSha256: string;
  bodySha256: string;
  approvedTitle: string;
  canonicalUrl: string;
  feedUrl: string;
  publishedAt: string;
  rssCheckedAt: string;
  recordedAt: string;
}

export interface TutorialPublicationManifestEntry {
  id: string;
  title: string;
  sourcePath: string;
  status: "rss_confirmed";
  canonicalUrl: string;
  publishedAt: string;
}

export type TutorialPublicationReceiptErrorCode =
  | "not_configured"
  | "invalid_input"
  | "conflict"
  | "network_error"
  | "rpc_error"
  | "invalid_response";

export class TutorialPublicationReceiptError extends Error {
  constructor(
    readonly code: TutorialPublicationReceiptErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TutorialPublicationReceiptError";
  }
}

interface ReceiptDependencies {
  env?: Environment;
  fetchImpl?: typeof fetch;
}

interface ReceiptConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

function hasSecret(value: string | undefined): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\r\n]/u.test(value);
}

function configuration(env: Environment): ReceiptConfiguration | null {
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

function requireConfiguration(env: Environment): ReceiptConfiguration {
  const configured = configuration(env);
  if (!configured) {
    throw new TutorialPublicationReceiptError(
      "not_configured",
      "The durable tutorial publication receipt is not configured.",
    );
  }
  return configured;
}

function isoTimestamp(value: string, label: string): string {
  if (value.length > 40 || containsCredentialLikeData(value)) {
    throw new TutorialPublicationReceiptError(
      "invalid_input",
      `${label} is invalid.`,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TutorialPublicationReceiptError(
      "invalid_input",
      `${label} is invalid.`,
    );
  }
  return new Date(milliseconds).toISOString();
}

function validateInput(
  input: TutorialPublicationReceiptInput,
): TutorialPublicationReceiptInput {
  const canonicalUrl = canonicalSubstackPostUrl(input.canonicalUrl);
  const approvedTitle = normalizeSubstackTitle(input.approvedTitle);
  const sourcePath = `docs/tutorials/${input.tutorialId}.md`;
  if (
    !TUTORIAL_ID.test(input.tutorialId)
    || !RUN_ID.test(input.runId)
    || !CANDIDATE_ID.test(input.candidateId)
    || input.sourcePath !== sourcePath
    || !SHA256.test(input.sourceSha256)
    || !SHA256.test(input.bodySha256)
    || !approvedTitle
    || approvedTitle !== input.approvedTitle
    || !canonicalUrl
    || canonicalUrl !== input.canonicalUrl
    || input.feedUrl !== DEFITUTORIALS_FEED_URL
    || containsCredentialLikeData(input.runId)
    || containsCredentialLikeData(input.candidateId)
    || containsCredentialLikeData(input.approvedTitle)
  ) {
    throw new TutorialPublicationReceiptError(
      "invalid_input",
      "The tutorial publication receipt input is invalid.",
    );
  }

  const publishedAt = isoTimestamp(input.publishedAt, "Published timestamp");
  const rssCheckedAt = isoTimestamp(input.rssCheckedAt, "RSS check timestamp");
  if (Date.parse(rssCheckedAt) < Date.parse(publishedAt)) {
    throw new TutorialPublicationReceiptError(
      "invalid_input",
      "The RSS check cannot predate publication.",
    );
  }

  return {
    ...input,
    approvedTitle,
    canonicalUrl,
    publishedAt,
    rssCheckedAt,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid response.",
    );
  }
  const row = record(value[0]);
  if (!row) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid response.",
    );
  }
  return row;
}

function exactText(
  row: Record<string, unknown>,
  key: string,
  expected: string,
): string {
  const value = row[key];
  if (value !== expected) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned mismatched evidence.",
    );
  }
  return value;
}

function returnedTimestamp(
  row: Record<string, unknown>,
  key: string,
  expected?: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length > 40) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid timestamp.",
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid timestamp.",
    );
  }
  const normalized = new Date(milliseconds).toISOString();
  if (expected && normalized !== expected) {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned mismatched evidence.",
    );
  }
  return normalized;
}

async function callReceiptRpc(
  input: TutorialPublicationReceiptInput,
  dependencies: ReceiptDependencies,
): Promise<unknown> {
  const configured = requireConfiguration(dependencies.env ?? process.env);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL(`rpc/${RECEIPT_RPC}`, configured.restUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: configured.serviceRoleKey,
          authorization: `Bearer ${configured.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_tutorial_id: input.tutorialId,
          p_run_id: input.runId,
          p_candidate_id: input.candidateId,
          p_source_path: input.sourcePath,
          p_source_sha256: input.sourceSha256,
          p_body_sha256: input.bodySha256,
          p_approved_title: input.approvedTitle,
          p_canonical_url: input.canonicalUrl,
          p_feed_url: input.feedUrl,
          p_published_at: input.publishedAt,
          p_rss_checked_at: input.rssCheckedAt,
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      },
    );
  } catch {
    throw new TutorialPublicationReceiptError(
      "network_error",
      "The durable tutorial publication receipt could not be reached.",
    );
  }
  if (!response.ok) {
    throw new TutorialPublicationReceiptError(
      "rpc_error",
      `The durable tutorial publication receipt rejected the request (${response.status}).`,
      response.status,
    );
  }
  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid response.",
    );
  }
}

export async function recordTutorialPublicationReceipt(
  rawInput: TutorialPublicationReceiptInput,
  dependencies: ReceiptDependencies = {},
): Promise<TutorialPublicationReceipt> {
  const input = validateInput(rawInput);
  const row = oneRow(await callReceiptRpc(input, dependencies));
  const result = row.result_code;
  if (result === "conflict") {
    throw new TutorialPublicationReceiptError(
      "conflict",
      "A different immutable receipt already exists for this tutorial.",
    );
  }
  if (result !== "recorded" && result !== "already_recorded") {
    throw new TutorialPublicationReceiptError(
      "invalid_response",
      "The tutorial publication receipt returned an invalid result.",
    );
  }

  return {
    result,
    tutorialId: exactText(row, "tutorial_id", input.tutorialId),
    runId: exactText(row, "run_id", input.runId),
    candidateId: exactText(row, "candidate_id", input.candidateId),
    sourcePath: exactText(row, "source_path", input.sourcePath),
    sourceSha256: exactText(row, "source_sha256", input.sourceSha256),
    bodySha256: exactText(row, "body_sha256", input.bodySha256),
    approvedTitle: exactText(row, "approved_title", input.approvedTitle),
    canonicalUrl: exactText(row, "canonical_url", input.canonicalUrl),
    feedUrl: exactText(row, "feed_url", input.feedUrl),
    publishedAt: returnedTimestamp(row, "published_at", input.publishedAt),
    rssCheckedAt: returnedTimestamp(row, "rss_checked_at", input.rssCheckedAt),
    recordedAt: returnedTimestamp(row, "recorded_at"),
  };
}

export function tutorialPublicationManifestEntry(
  receipt: TutorialPublicationReceipt,
): TutorialPublicationManifestEntry {
  return {
    id: receipt.tutorialId,
    title: receipt.approvedTitle,
    sourcePath: receipt.sourcePath,
    status: "rss_confirmed",
    canonicalUrl: receipt.canonicalUrl,
    publishedAt: receipt.publishedAt,
  };
}

export function tutorialPublicationManifestPatch(
  entry: TutorialPublicationManifestEntry,
): string {
  return JSON.stringify(entry, null, 2);
}
