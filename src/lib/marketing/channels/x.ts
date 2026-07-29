import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import type { MarketingInteraction } from "@/lib/marketing/types";
import { parseCanonicalXStatusUrl } from "@/lib/marketing/x-interaction";

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
const X_POST_ID = /^\d{1,19}$/u;
const X_ACCOUNT_ID = /^\d{1,30}$/u;
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

export interface XAuthenticatedIdentity {
  authenticatedAccountId: string;
  authenticatedUsername: string;
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
    payload: await readBoundedJsonResponse("x", response),
    response,
  };
}

/**
 * Publish through X API v2 only. The idempotency key is deliberately retained
 * in the workflow result but is not sent as a made-up provider header.
 */
export async function publishXPost(
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
        made_with_ai: true,
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
): Promise<MarketingInteraction> {
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
    id,
    targetUrl: target.url,
    authorId,
    authenticatedAccountId,
    trigger: isMention ? "mention" : "quote",
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
    "replyToTweetId" | "expectedAuthenticatedAccountId" | "madeWithAi"
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
