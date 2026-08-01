import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";
import {
  renderXMentionReply,
  type XMentionTemplateId,
} from "@/lib/marketing/x-mentions";

import {
  ChannelAdapterError,
  assertIdempotencyKey,
  parseXRateLimit,
  providerError,
  readBoundedJsonResponse,
  safelyFetch,
  type ChannelFetch,
  type ProviderRateLimit,
} from "./shared";

const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const X_CURRENT_USER_URL = "https://api.x.com/2/users/me";
const X_STATUS_URL = "https://x.com/i/web/status";
const X_POST_MAX_CODE_POINTS = 280;
const X_MENTIONS_RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;
const X_POST_ID = /^\d{1,19}$/u;
const X_ACCOUNT_ID = /^\d{1,19}$/u;
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/u;

export interface XPublishInput {
  text: string;
  idempotencyKey: string;
  /** False only for exact server-authored deterministic templates. */
  madeWithAi?: boolean;
  replyToTweetId?: string;
  /** Immutable account id recorded when the reply target was verified. */
  expectedAuthenticatedAccountId?: string;
}

export interface XPublishResult {
  channel: "x";
  mode: "broadcast" | "reply";
  providerMessageId: string;
  providerUrl: string;
  idempotencyKey: string;
  rateLimit?: ProviderRateLimit;
}

export interface XOAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XAdapterDependencies {
  /**
   * OAuth 2.0 user-context token. OAuth 1.0a is preferred whenever all four
   * OAuth 1.0a credentials are present.
   */
  userAccessToken?: string;
  oauth1Credentials?: Partial<XOAuth1Credentials>;
  fetchImpl?: ChannelFetch;
  nowMs?: number;
  requestTimeoutMs?: number;
  expectedAccountId?: string;
  expectedUsername?: string;
  /** Deterministic injection for tests; production generates a fresh nonce. */
  oauth1Nonce?: () => string;
}

export type XPublishDependencies = XAdapterDependencies;
export type XVerificationDependencies = XAdapterDependencies;

export interface XMentionObservation {
  id: string;
  authorId: string;
  conversationId: string;
  /** Transient provider data. Callers must never persist or log this field. */
  text: string;
  createdAt: string;
  possiblySensitive: boolean;
  authorProtected: boolean;
  isWithheld: boolean;
  hasMedia: boolean;
  hasExternalLink: boolean;
  isRepost: boolean;
}

export interface XMentionsPage {
  authenticatedAccountId: string;
  authenticatedUsername: string;
  mentions: XMentionObservation[];
  newestId: string | null;
  oldestId: string | null;
  nextToken: string | null;
  rateLimit?: ProviderRateLimit;
}

export interface XMentionsPageInput {
  sinceId?: string;
  untilId?: string;
  startTime?: string;
  paginationToken?: string;
  maxResults?: number;
}

export interface XAuthenticatedIdentity {
  authenticatedAccountId: string;
  authenticatedUsername: string;
  observedAt: string;
}

export interface XComplianceLookupInput {
  postIds: readonly string[];
  userIds: readonly string[];
}

export interface XComplianceLookupObservation {
  subjectKind: "post" | "user";
  subjectId: string;
  status: "present" | "absent" | "protected" | "withheld";
}

export interface XComplianceLookupResult {
  authenticatedAccountId: string;
  observedAt: string;
  observations: XComplianceLookupObservation[];
}

/**
 * Transient provider subject metadata. This type must stay inside the API
 * route or the single final-delivery step; never serialize it into Workflow.
 */
export interface XVerifiedReplyTarget {
  postId: string;
  targetUrl: string;
  authorId: string;
  authenticatedAccountId: string;
  trigger: "mention" | "quote";
  observedAt: string;
}

interface XCreatePostResponse {
  data?: {
    id?: unknown;
  };
}

interface JsonRecord {
  [key: string]: unknown;
}

type ResolvedXAuth =
  | { kind: "oauth2"; accessToken: string }
  | { kind: "oauth1"; credentials: XOAuth1Credentials };

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function optionalOpaquePaginationToken(value: unknown): string | null {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 2_048
    && !/[\s\r\n]/u.test(value)
    ? value
    : null;
}

function compareXIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseXMentionObservation(
  value: unknown,
  expectedUsername: string,
  authorProtected: boolean,
): XMentionObservation | null {
  const tweet = record(value);
  if (!tweet) return null;
  const id = tweet.id;
  const authorId = tweet.author_id;
  const conversationId = tweet.conversation_id;
  const text = tweet.text;
  const createdAt = tweet.created_at;
  const possiblySensitive = tweet.possibly_sensitive;
  if (
    typeof id !== "string"
    || !X_POST_ID.test(id)
    || typeof authorId !== "string"
    || !X_ACCOUNT_ID.test(authorId)
    || typeof conversationId !== "string"
    || !X_POST_ID.test(conversationId)
    || typeof text !== "string"
    || text.length < 1
    || text.length > 10_000
    || typeof createdAt !== "string"
    || !Number.isFinite(Date.parse(createdAt))
    || typeof possiblySensitive !== "boolean"
  ) return null;

  const entities = record(tweet.entities);
  if (!entities || !Array.isArray(entities.mentions)) return null;
  const mentions = entities.mentions.map(record);
  if (
    mentions.some(
      (mention) =>
        !mention
        || typeof mention.username !== "string"
        || !X_USERNAME.test(mention.username),
    )
  ) return null;
  const explicitlyMentionsAccount = mentions.some(
    (mention) =>
      typeof mention?.username === "string"
      && mention.username.toLowerCase() === expectedUsername,
  );
  if (!explicitlyMentionsAccount) return null;

  const rawUrls = entities.urls;
  if (rawUrls !== undefined && !Array.isArray(rawUrls)) return null;
  const urls = Array.isArray(rawUrls) ? rawUrls.map(record) : [];
  if (urls.some((url) => !url)) return null;

  const attachments = tweet.attachments === undefined
    ? null
    : record(tweet.attachments);
  if (tweet.attachments !== undefined && !attachments) return null;
  const rawMediaKeys = attachments?.media_keys;
  if (rawMediaKeys !== undefined && !Array.isArray(rawMediaKeys)) return null;
  const mediaKeys = Array.isArray(rawMediaKeys) ? rawMediaKeys : [];
  if (mediaKeys.some((key) => typeof key !== "string" || !key)) return null;

  const rawReferences = tweet.referenced_tweets;
  if (rawReferences !== undefined && !Array.isArray(rawReferences)) return null;
  const references = Array.isArray(rawReferences)
    ? rawReferences.map(record)
    : [];
  if (
    references.some(
      (reference) =>
        !reference
        || typeof reference.id !== "string"
        || !X_POST_ID.test(reference.id)
        || !["retweeted", "quoted", "replied_to"].includes(
          String(reference.type),
        ),
    )
  ) return null;

  return {
    id,
    authorId,
    conversationId,
    text,
    createdAt: new Date(createdAt).toISOString(),
    possiblySensitive,
    authorProtected,
    isWithheld: tweet.withheld !== undefined,
    hasMedia: mediaKeys.length > 0,
    hasExternalLink: urls.length > 0,
    isRepost: references.some((reference) => reference?.type === "retweeted"),
  };
}

function cleanSecret(value: string | undefined): string | null {
  return value && value.trim() && !/[\r\n]/u.test(value)
    ? value.trim()
    : null;
}

function resolveXAuth(dependencies: XAdapterDependencies): ResolvedXAuth {
  const explicit = dependencies.oauth1Credentials;
  const oauth1 = {
    consumerKey: cleanSecret(explicit?.consumerKey ?? process.env.X_CONSUMER_KEY),
    consumerSecret: cleanSecret(explicit?.consumerSecret ?? process.env.X_CONSUMER_SECRET),
    accessToken: cleanSecret(explicit?.accessToken ?? process.env.X_ACCESS_TOKEN),
    accessTokenSecret: cleanSecret(
      explicit?.accessTokenSecret ?? process.env.X_ACCESS_TOKEN_SECRET,
    ),
  };
  const oauthValues = Object.values(oauth1);
  if (oauthValues.every((value) => value !== null)) {
    return { kind: "oauth1", credentials: oauth1 as XOAuth1Credentials };
  }
  if (oauthValues.some((value) => value !== null)) {
    throw new ChannelAdapterError(
      "x",
      "not-configured",
      "x publishing is not configured.",
    );
  }

  const accessToken = cleanSecret(
    dependencies.userAccessToken ?? process.env.X_USER_ACCESS_TOKEN,
  );
  if (accessToken) return { kind: "oauth2", accessToken };
  throw new ChannelAdapterError(
    "x",
    "not-configured",
    "x publishing is not configured.",
  );
}

function resolveExpectedXIdentity(
  dependencies: XAdapterDependencies,
): { accountId: string; username: string } {
  const accountId =
    dependencies.expectedAccountId ?? process.env.X_EXPECTED_ACCOUNT_ID;
  const username =
    dependencies.expectedUsername ?? process.env.X_EXPECTED_USERNAME;
  if (
    typeof accountId !== "string"
    || !X_ACCOUNT_ID.test(accountId)
    || typeof username !== "string"
    || !/^[a-z0-9_]{1,15}$/u.test(username)
  ) {
    throw new ChannelAdapterError(
      "x",
      "not-configured",
      "x publishing identity is not configured.",
    );
  }
  return { accountId, username };
}

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauth1Authorization(
  method: string,
  rawUrl: string,
  credentials: XOAuth1Credentials,
  dependencies: XAdapterDependencies,
): string {
  const url = new URL(rawUrl);
  const nonce = dependencies.oauth1Nonce?.() ?? randomBytes(16).toString("hex");
  const timestamp = Math.floor((dependencies.nowMs ?? Date.now()) / 1_000);
  if (!nonce || /[\r\n]/u.test(nonce) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new ChannelAdapterError("x", "invalid-input", "Invalid OAuth signing inputs.");
  }

  const oauthParameters: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const signatureParameters = [
    ...url.searchParams.entries(),
    ...Object.entries(oauthParameters),
  ]
    .map(([key, value]) => [oauthPercentEncode(key), oauthPercentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const normalizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const signatureBase = [
    method.toUpperCase(),
    oauthPercentEncode(normalizedUrl),
    oauthPercentEncode(signatureParameters),
  ].join("&");
  const signingKey =
    `${oauthPercentEncode(credentials.consumerSecret)}&`
    + oauthPercentEncode(credentials.accessTokenSecret);
  const signature = createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");
  const headerParameters = {
    ...oauthParameters,
    oauth_signature: signature,
  };
  return `OAuth ${Object.entries(headerParameters)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(", ")}`;
}

export function createXOAuth1AuthorizationHeader(
  method: string,
  url: string,
  credentials: XOAuth1Credentials,
  dependencies: Pick<XAdapterDependencies, "nowMs" | "oauth1Nonce"> = {},
): string {
  return oauth1Authorization(method, url, credentials, dependencies);
}

function xAuthorization(
  method: string,
  url: string,
  dependencies: XAdapterDependencies,
): string {
  const auth = resolveXAuth(dependencies);
  return auth.kind === "oauth1"
    ? oauth1Authorization(method, url, auth.credentials, dependencies)
    : `Bearer ${auth.accessToken}`;
}

function validateXInput(input: XPublishInput): void {
  assertIdempotencyKey("x", input.idempotencyKey);

  if (!input.text.trim()) {
    throw new ChannelAdapterError("x", "invalid-input", "X post text is required.");
  }
  if (Array.from(input.text).length > X_POST_MAX_CODE_POINTS) {
    throw new ChannelAdapterError(
      "x",
      "invalid-input",
      `X post text must be at most ${X_POST_MAX_CODE_POINTS} characters.`,
    );
  }
  if (input.replyToTweetId !== undefined && !X_POST_ID.test(input.replyToTweetId)) {
    throw new ChannelAdapterError(
      "x",
      "invalid-input",
      "X reply target must be a 1-19 digit post ID.",
    );
  }
  if (
    input.replyToTweetId !== undefined
    && (
      input.expectedAuthenticatedAccountId === undefined
      || !X_ACCOUNT_ID.test(input.expectedAuthenticatedAccountId)
    )
  ) {
    throw new ChannelAdapterError(
      "x",
      "invalid-input",
      "X replies require the verified authenticated account id.",
    );
  }
}

async function xJsonRequest(
  method: "GET" | "POST",
  url: string,
  dependencies: XAdapterDependencies,
  body?: string,
  maxResponseBytes?: number,
): Promise<{ payload: unknown; response: Response }> {
  const response = await safelyFetch(
    "x",
    dependencies.fetchImpl ?? fetch,
    url,
    {
      method,
      headers: {
        accept: "application/json",
        authorization: xAuthorization(method, url, dependencies),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      redirect: "error",
    },
    dependencies.requestTimeoutMs,
  );
  if (!response.ok) throw providerError("x", response, dependencies.nowMs);
  return {
    payload: await readBoundedJsonResponse("x", response, maxResponseBytes),
    response,
  };
}

/**
 * Publish through X API v2 only. The idempotency key is deliberately retained
 * in the workflow result but is not sent as a made-up provider header.
 */
async function publishXPost(
  input: XPublishInput,
  dependencies: XPublishDependencies = {},
): Promise<XPublishResult> {
  validateXInput(input);
  const identity = await verifyXAuthenticatedIdentity(dependencies);
  if (
    input.replyToTweetId
    && identity.authenticatedAccountId !== input.expectedAuthenticatedAccountId
  ) {
    throw invalidVerification(
      "The current X credentials do not match the account that verified this reply target.",
    );
  }
  const body = input.replyToTweetId
    ? {
        text: input.text,
        made_with_ai: input.madeWithAi ?? true,
        reply: { in_reply_to_tweet_id: input.replyToTweetId },
      }
    : { text: input.text, made_with_ai: input.madeWithAi ?? true };
  const { payload, response } = await xJsonRequest(
    "POST",
    X_CREATE_POST_URL,
    dependencies,
    JSON.stringify(body),
  );
  const id = (payload as XCreatePostResponse).data?.id;
  if (typeof id !== "string" || !X_POST_ID.test(id)) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned an invalid response.",
      { status: response.status },
    );
  }

  return {
    channel: "x",
    mode: input.replyToTweetId ? "reply" : "broadcast",
    providerMessageId: id,
    providerUrl: `${X_STATUS_URL}/${id}`,
    idempotencyKey: input.idempotencyKey,
    rateLimit: parseXRateLimit(response.headers),
  };
}

function invalidVerification(message: string): ChannelAdapterError {
  return new ChannelAdapterError("x", "invalid-input", message);
}

/**
 * Resolve the current user through X and bind credentials to the exact
 * operator-configured account id and canonical username.
 */
export async function verifyXAuthenticatedIdentity(
  dependencies: XVerificationDependencies = {},
): Promise<XAuthenticatedIdentity> {
  const expected = resolveExpectedXIdentity(dependencies);
  const { payload } = await xJsonRequest(
    "GET",
    X_CURRENT_USER_URL,
    dependencies,
  );
  const currentUser = record(record(payload)?.data);
  const authenticatedAccountId = currentUser?.id;
  const authenticatedUsername = currentUser?.username;
  if (
    typeof authenticatedAccountId !== "string"
    || !X_ACCOUNT_ID.test(authenticatedAccountId)
    || typeof authenticatedUsername !== "string"
    || !X_USERNAME.test(authenticatedUsername)
  ) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned an invalid authenticated-account response.",
    );
  }
  if (
    authenticatedAccountId !== expected.accountId
    || authenticatedUsername.toLowerCase() !== expected.username
  ) {
    throw invalidVerification(
      "The current X credentials do not match the configured OpenZaps identity.",
    );
  }
  return {
    authenticatedAccountId,
    authenticatedUsername,
    observedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
  };
}

/**
 * Verify an operator-selected reply target through X user-context endpoints.
 * Only immutable metadata leaves this adapter; target post text is discarded.
 */
export async function verifyXReplyTarget(
  targetUrl: string,
  dependencies: XVerificationDependencies = {},
): Promise<XVerifiedReplyTarget> {
  let target;
  try {
    target = parseCanonicalXStatusUrl(targetUrl);
  } catch {
    throw invalidVerification(
      "X target must be https://x.com/<user>/status/<1-19 digit id>.",
    );
  }

  const identity = await verifyXAuthenticatedIdentity(dependencies);
  const authenticatedAccountId = identity.authenticatedAccountId;
  const authenticatedUsername = identity.authenticatedUsername;

  const query = new URLSearchParams({
    expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id",
    "tweet.fields": "author_id,entities,referenced_tweets",
    "user.fields": "username",
  });
  const tweetUrl = `https://api.x.com/2/tweets/${target.postId}?${query.toString()}`;
  const { payload: targetPayload } = await xJsonRequest("GET", tweetUrl, dependencies);
  const root = record(targetPayload);
  const tweet = record(root?.data);
  if (!tweet) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned invalid target metadata.",
    );
  }
  const id = tweet?.id;
  const authorId = tweet?.author_id;
  if (
    id !== target.postId
    || typeof authorId !== "string"
    || !X_ACCOUNT_ID.test(authorId)
  ) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned invalid target metadata.",
    );
  }
  if (authorId === authenticatedAccountId) {
    throw invalidVerification("The authenticated OpenZaps account cannot reply to itself.");
  }

  const includes = record(root?.includes);
  const users = Array.isArray(includes?.users) ? includes.users.map(record).filter(Boolean) : [];
  const targetAuthor = users.find((user) => user?.id === authorId);
  const targetAuthorUsername = targetAuthor?.username;
  if (
    typeof targetAuthorUsername !== "string"
    || targetAuthorUsername.toLowerCase() !== target.username.toLowerCase()
  ) {
    throw invalidVerification("The X target URL does not match the target post author.");
  }

  const entities = record(tweet.entities);
  const mentions = Array.isArray(entities?.mentions)
    ? entities.mentions.map(record).filter(Boolean)
    : [];
  const isMention = mentions.some(
    (mention) =>
      typeof mention?.username === "string"
      && mention.username.toLowerCase() === authenticatedUsername.toLowerCase(),
  );

  const references = Array.isArray(tweet.referenced_tweets)
    ? tweet.referenced_tweets.map(record).filter(Boolean)
    : [];
  const quotedIds = new Set(
    references
      .filter((reference) => reference?.type === "quoted")
      .map((reference) => reference?.id)
      .filter((referenceId): referenceId is string =>
        typeof referenceId === "string" && X_POST_ID.test(referenceId),
      ),
  );
  const expandedTweets = Array.isArray(includes?.tweets)
    ? includes.tweets.map(record).filter(Boolean)
    : [];
  const isOwnedQuote = expandedTweets.some(
    (expanded) =>
      typeof expanded?.id === "string"
      && quotedIds.has(expanded.id)
      && expanded.author_id === authenticatedAccountId,
  );
  if (!isMention && !isOwnedQuote) {
    throw invalidVerification(
      "The target must explicitly mention OpenZaps or quote an OpenZaps post.",
    );
  }

  return {
    postId: id,
    targetUrl: target.url,
    authorId,
    authenticatedAccountId,
    trigger: isMention ? "mention" : "quote",
    observedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
  };
}

function exactUniqueXIds(
  values: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw invalidVerification(`${label} accepts at most 100 ids.`);
  }
  const ids = [...values];
  if (ids.some((value) => typeof value !== "string" || !X_POST_ID.test(value))) {
    throw invalidVerification(`${label} contains an invalid id.`);
  }
  if (new Set(ids).size !== ids.length) {
    throw invalidVerification(`${label} ids must be unique.`);
  }
  return ids;
}

function lookupErrorSubjectId(value: unknown): string | null {
  const error = record(value);
  if (!error) return null;
  const candidate = error.resource_id ?? error.value;
  return typeof candidate === "string" && X_POST_ID.test(candidate)
    ? candidate
    : null;
}

async function lookupXComplianceKind(
  subjectKind: "post" | "user",
  ids: readonly string[],
  dependencies: XVerificationDependencies,
): Promise<XComplianceLookupObservation[]> {
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ ids: ids.join(",") });
  if (subjectKind === "post") {
    query.set("tweet.fields", "author_id,withheld");
  } else {
    query.set("user.fields", "protected,withheld");
  }
  const url = subjectKind === "post"
    ? `https://api.x.com/2/tweets?${query.toString()}`
    : `https://api.x.com/2/users?${query.toString()}`;
  const { payload, response } = await xJsonRequest(
    "GET",
    url,
    dependencies,
    undefined,
    X_MENTIONS_RESPONSE_MAX_BYTES,
  );
  const root = record(payload);
  const rawData = root?.data;
  const data = rawData === undefined ? [] : Array.isArray(rawData) ? rawData : null;
  const rawErrors = root?.errors;
  const errors = rawErrors === undefined
    ? []
    : Array.isArray(rawErrors)
      ? rawErrors
      : null;
  if (!root || data === null || errors === null) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned an invalid compliance lookup response.",
      { status: response.status },
    );
  }

  const requested = new Set(ids);
  const observations = new Map<string, XComplianceLookupObservation>();
  for (const raw of data) {
    const subject = record(raw);
    const id = subject?.id;
    if (
      !subject
      || typeof id !== "string"
      || !requested.has(id)
      || observations.has(id)
    ) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned invalid compliance lookup subjects.",
        { status: response.status },
      );
    }
    if (
      subjectKind === "post"
      && (
        typeof subject.author_id !== "string"
        || !X_ACCOUNT_ID.test(subject.author_id)
      )
    ) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned invalid compliance lookup post metadata.",
        { status: response.status },
      );
    }
    if (
      subjectKind === "user"
      && typeof subject.protected !== "boolean"
    ) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned invalid compliance lookup user metadata.",
        { status: response.status },
      );
    }
    observations.set(id, {
      subjectKind,
      subjectId: id,
      status:
        subject.withheld !== undefined
          ? "withheld"
          : subjectKind === "user" && subject.protected === true
            ? "protected"
            : "present",
    });
  }

  for (const raw of errors) {
    const id = lookupErrorSubjectId(raw);
    if (!id || !requested.has(id) || observations.has(id)) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned invalid compliance lookup errors.",
        { status: response.status },
      );
    }
    observations.set(id, {
      subjectKind,
      subjectId: id,
      status: "absent",
    });
  }

  if (observations.size !== ids.length) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X compliance lookup did not cover every requested subject.",
      { status: response.status },
    );
  }
  return ids.map((id) => observations.get(id) as XComplianceLookupObservation);
}

/**
 * Reconcile stored X object ids through official lookup endpoints. The caller
 * may persist only the bounded status observations, never response bodies.
 */
export async function lookupXComplianceSubjects(
  input: XComplianceLookupInput,
  dependencies: XVerificationDependencies = {},
): Promise<XComplianceLookupResult> {
  const postIds = exactUniqueXIds(input.postIds, "X post lookup");
  const userIds = exactUniqueXIds(input.userIds, "X user lookup");
  if (postIds.length + userIds.length === 0) {
    throw invalidVerification("X compliance lookup requires at least one subject.");
  }
  const identity = await verifyXAuthenticatedIdentity(dependencies);
  const [posts, users] = await Promise.all([
    lookupXComplianceKind("post", postIds, dependencies),
    lookupXComplianceKind("user", userIds, dependencies),
  ]);
  return {
    authenticatedAccountId: identity.authenticatedAccountId,
    observedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
    observations: [...posts, ...users],
  };
}

/**
 * Read one official mentions-timeline page. Post text is returned only as
 * transient adapter data so the caller can classify and HMAC it; it must not
 * enter logs, database rows, workflow arguments, or API responses.
 */
export async function fetchXMentionsPage(
  input: XMentionsPageInput = {},
  dependencies: XVerificationDependencies = {},
): Promise<XMentionsPage> {
  if (input.sinceId !== undefined && !X_POST_ID.test(input.sinceId)) {
    throw invalidVerification("X mentions since_id must be a 1-19 digit post ID.");
  }
  if (input.untilId !== undefined && !X_POST_ID.test(input.untilId)) {
    throw invalidVerification("X mentions until_id must be a 1-19 digit post ID.");
  }
  if (
    input.startTime !== undefined
    && (
      !Number.isFinite(Date.parse(input.startTime))
      || new Date(input.startTime).toISOString() !== input.startTime
    )
  ) {
    throw invalidVerification("X mentions start_time must be an ISO timestamp.");
  }
  if (
    input.paginationToken !== undefined
    && optionalOpaquePaginationToken(input.paginationToken) === null
  ) {
    throw invalidVerification("X mentions pagination token is invalid.");
  }
  const maxResults = input.maxResults ?? 100;
  if (!Number.isSafeInteger(maxResults) || maxResults < 5 || maxResults > 100) {
    throw invalidVerification("X mentions max_results must be from 5 to 100.");
  }

  const identity = await verifyXAuthenticatedIdentity(dependencies);
  const query = new URLSearchParams({
    max_results: String(maxResults),
    expansions: "author_id",
    "tweet.fields":
      "author_id,conversation_id,created_at,entities,attachments,possibly_sensitive,referenced_tweets,withheld",
    "user.fields": "username,protected",
    ...(input.sinceId ? { since_id: input.sinceId } : {}),
    ...(input.untilId ? { until_id: input.untilId } : {}),
    ...(input.startTime ? { start_time: input.startTime } : {}),
    ...(input.paginationToken
      ? { pagination_token: input.paginationToken }
      : {}),
  });
  const url =
    `https://api.x.com/2/users/${identity.authenticatedAccountId}/mentions?${query.toString()}`;
  const { payload, response } = await xJsonRequest(
    "GET",
    url,
    dependencies,
    undefined,
    X_MENTIONS_RESPONSE_MAX_BYTES,
  );
  const root = record(payload);
  const errors = Array.isArray(root?.errors) ? root.errors : [];
  const rawData = root?.data;
  const data = rawData === undefined ? [] : Array.isArray(rawData) ? rawData : null;
  const meta = record(root?.meta);
  const resultCount = meta?.result_count;
  const newestId = meta?.newest_id;
  const oldestId = meta?.oldest_id;
  const rawNextToken = meta?.next_token;
  const nextToken = rawNextToken === undefined
    ? null
    : optionalOpaquePaginationToken(rawNextToken);
  if (
    !root
    || errors.length > 0
    || data === null
    || !Number.isSafeInteger(resultCount)
    || Number(resultCount) !== data.length
    || (
      data.length === 0
      && (
        newestId !== undefined
        || oldestId !== undefined
        || rawNextToken !== undefined
      )
    )
    || (
      data.length > 0
      && (
        typeof newestId !== "string"
        || !X_POST_ID.test(newestId)
        || typeof oldestId !== "string"
        || !X_POST_ID.test(oldestId)
      )
    )
    || (rawNextToken !== undefined && nextToken === null)
  ) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned an invalid mentions response.",
      { status: response.status },
    );
  }

  const includedUsers = Array.isArray(record(root?.includes)?.users)
    ? (record(root?.includes)?.users as unknown[]).map(record)
    : [];
  if (includedUsers.some((user) => !user)) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned invalid mention author metadata.",
      { status: response.status },
    );
  }
  const protectedAuthors = new Map<string, boolean>();
  for (const user of includedUsers) {
    if (
      typeof user?.id !== "string"
      || !X_ACCOUNT_ID.test(user.id)
      || typeof user.protected !== "boolean"
    ) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned invalid mention author metadata.",
        { status: response.status },
      );
    }
    if (protectedAuthors.has(user.id)) {
      throw new ChannelAdapterError(
        "x",
        "invalid-response",
        "X returned duplicate mention author metadata.",
        { status: response.status },
      );
    }
    protectedAuthors.set(user.id, user.protected);
  }
  const mentions = data.map((item) => {
    const authorId = record(item)?.author_id;
    const authorProtected = typeof authorId === "string"
      ? protectedAuthors.get(authorId)
      : undefined;
    return typeof authorProtected === "boolean"
      ? parseXMentionObservation(
          item,
          identity.authenticatedUsername.toLowerCase(),
          authorProtected,
        )
      : null;
  });
  if (mentions.some((mention) => mention === null)) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned invalid mention metadata.",
      { status: response.status },
    );
  }
  const parsedMentions = mentions as XMentionObservation[];
  const postIds = parsedMentions.map((mention) => mention.id);
  const uniquePostIds = new Set(postIds);
  const actualNewestId = postIds.reduce<string | null>(
    (current, id) => current === null || compareXIds(id, current) > 0 ? id : current,
    null,
  );
  const actualOldestId = postIds.reduce<string | null>(
    (current, id) => current === null || compareXIds(id, current) < 0 ? id : current,
    null,
  );
  if (
    uniquePostIds.size !== postIds.length
    || (postIds.length > 0 && (
      newestId !== actualNewestId
      || oldestId !== actualOldestId
      || (input.sinceId !== undefined
        && postIds.some((id) => compareXIds(id, input.sinceId as string) <= 0))
      || (input.untilId !== undefined
        && postIds.some((id) => compareXIds(id, input.untilId as string) >= 0))
    ))
  ) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X returned inconsistent mention page boundaries.",
      { status: response.status },
    );
  }
  return {
    authenticatedAccountId: identity.authenticatedAccountId,
    authenticatedUsername: identity.authenticatedUsername,
    mentions: parsedMentions,
    newestId: data.length === 0 ? null : (newestId as string),
    oldestId: data.length === 0 ? null : (oldestId as string),
    nextToken,
    rateLimit: parseXRateLimit(response.headers),
  };
}

/** Re-read one claimed mention immediately before durable delivery admission. */
export async function verifyXMentionById(
  postId: string,
  expectedAuthorId: string,
  dependencies: XVerificationDependencies = {},
): Promise<{
  authenticatedAccountId: string;
  authenticatedUsername: string;
  mention: XMentionObservation;
  observedAt: string;
}> {
  if (!X_POST_ID.test(postId) || !X_ACCOUNT_ID.test(expectedAuthorId)) {
    throw invalidVerification("X mention verification identity is invalid.");
  }
  const identity = await verifyXAuthenticatedIdentity(dependencies);
  const query = new URLSearchParams({
    expansions: "author_id",
    "tweet.fields":
      "author_id,conversation_id,created_at,entities,attachments,possibly_sensitive,referenced_tweets,withheld",
    "user.fields": "username,protected",
  });
  const url = `https://api.x.com/2/tweets/${postId}?${query.toString()}`;
  const { payload, response } = await xJsonRequest("GET", url, dependencies);
  const root = record(payload);
  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    throw new ChannelAdapterError(
      "x",
      "invalid-response",
      "X mention revalidation failed.",
      { status: response.status },
    );
  }
  const authorId = record(root?.data)?.author_id;
  const includedUsers = Array.isArray(record(root?.includes)?.users)
    ? (record(root?.includes)?.users as unknown[]).map(record).filter(Boolean)
    : [];
  const author = includedUsers.find((user) => user?.id === authorId);
  const mention = author && typeof author.protected === "boolean"
    ? parseXMentionObservation(
        root?.data,
        identity.authenticatedUsername.toLowerCase(),
        author.protected,
      )
    : null;
  if (!mention || mention.id !== postId || mention.authorId !== expectedAuthorId) {
    throw invalidVerification(
      "X mention metadata changed or no longer identifies the claimed author.",
    );
  }
  if (mention.authorId === identity.authenticatedAccountId) {
    throw invalidVerification("The authenticated OpenZaps account cannot reply to itself.");
  }
  return {
    authenticatedAccountId: identity.authenticatedAccountId,
    authenticatedUsername: identity.authenticatedUsername,
    mention,
    observedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
  };
}

export function postXBroadcast(
  input: Omit<XPublishInput, "replyToTweetId">,
  dependencies?: XPublishDependencies,
): Promise<XPublishResult> {
  return publishXPost(input, dependencies);
}

export function postXReply(
  input: Omit<
    XPublishInput,
    "madeWithAi" | "replyToTweetId" | "expectedAuthenticatedAccountId"
  > & {
    inReplyToTweetId: string;
    authenticatedAccountId: string;
  },
  dependencies?: XPublishDependencies,
): Promise<XPublishResult> {
  return publishXPost(
    {
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      replyToTweetId: input.inReplyToTweetId,
      expectedAuthenticatedAccountId: input.authenticatedAccountId,
      madeWithAi: true,
    },
    dependencies,
  );
}

export function postXDeterministicMentionReply(
  input: {
    templateId: XMentionTemplateId;
    inReplyToTweetId: string;
    authenticatedAccountId: string;
    idempotencyKey: string;
  },
  dependencies?: XPublishDependencies,
): Promise<XPublishResult> {
  return publishXPost(
    {
      text: renderXMentionReply(input.templateId),
      idempotencyKey: input.idempotencyKey,
      replyToTweetId: input.inReplyToTweetId,
      expectedAuthenticatedAccountId: input.authenticatedAccountId,
      madeWithAi: false,
    },
    dependencies,
  );
}
