import "server-only";

export type MarketingChannel = "x" | "discord" | "substack";

export type ChannelErrorCode =
  | "not-configured"
  | "invalid-input"
  | "network-error"
  | "provider-error"
  | "rate-limited"
  | "invalid-response";

export interface ProviderRateLimit {
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

/**
 * A deliberately small, secret-free error surface for channel routes and
 * workflows. Provider response bodies are never copied into this error: they
 * can echo request content or credentials.
 */
export class ChannelAdapterError extends Error {
  constructor(
    readonly channel: MarketingChannel,
    readonly code: ChannelErrorCode,
    message: string,
    readonly details: {
      status?: number;
      retryAfterMs?: number;
      rateLimit?: ProviderRateLimit;
    } = {},
  ) {
    super(message);
    this.name = "ChannelAdapterError";
  }
}

export type ChannelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PROVIDER_RESPONSE_MAX_BYTES = 64 * 1_024;

export function assertIdempotencyKey(
  channel: MarketingChannel,
  idempotencyKey: string,
): void {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new ChannelAdapterError(
      channel,
      "invalid-input",
      "idempotencyKey must be 1-200 URL-safe characters.",
    );
  }
}

export function requireServerSecret(
  channel: MarketingChannel,
  envName: string,
  explicitValue?: string,
): string {
  const value = explicitValue ?? process.env[envName];
  if (!value || !value.trim() || /[\r\n]/.test(value)) {
    throw new ChannelAdapterError(
      channel,
      "not-configured",
      `${channel} publishing is not configured.`,
    );
  }
  return value.trim();
}

export function parsePositiveIntegerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(Math.ceil(milliseconds))
      ? Math.ceil(milliseconds)
      : undefined;
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export function parseXRateLimit(
  headers: Headers,
): ProviderRateLimit | undefined {
  const limit = parsePositiveIntegerHeader(headers.get("x-rate-limit-limit"));
  const remaining = parsePositiveIntegerHeader(
    headers.get("x-rate-limit-remaining"),
  );
  const resetSeconds = parsePositiveIntegerHeader(
    headers.get("x-rate-limit-reset"),
  );
  const resetDate =
    resetSeconds === undefined ? undefined : new Date(resetSeconds * 1_000);
  const resetAt =
    resetDate && Number.isFinite(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined;

  return limit === undefined && remaining === undefined && resetAt === undefined
    ? undefined
    : { limit, remaining, resetAt };
}

export function providerError(
  channel: MarketingChannel,
  response: Response,
  nowMs = Date.now(),
  providerRetryAfterMs?: number,
): ChannelAdapterError {
  const headerRetryAfterMs = parseRetryAfterMs(
    response.headers.get("retry-after"),
    nowMs,
  );
  const retryAfterMs = providerRetryAfterMs ?? headerRetryAfterMs;
  const rateLimit =
    channel === "x" ? parseXRateLimit(response.headers) : undefined;
  const rateLimited = response.status === 429;

  return new ChannelAdapterError(
    channel,
    rateLimited ? "rate-limited" : "provider-error",
    rateLimited
      ? `${channel} is rate limiting requests.`
      : `${channel} request failed with status ${response.status}.`,
    {
      status: response.status,
      retryAfterMs,
      rateLimit,
    },
  );
}

export async function safelyFetch(
  channel: MarketingChannel,
  fetchImpl: ChannelFetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs = DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const boundedTimeout =
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(boundedTimeout);
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch {
    throw new ChannelAdapterError(
      channel,
      "network-error",
      `${channel} could not be reached.`,
    );
  }
}

function invalidProviderResponse(
  channel: MarketingChannel,
  status: number,
): ChannelAdapterError {
  return new ChannelAdapterError(
    channel,
    "invalid-response",
    `${channel} returned an invalid response.`,
    { status },
  );
}

/**
 * Parse a small provider JSON receipt without letting an unexpected response
 * buffer an unbounded body in a publishing step.
 */
export async function readBoundedJsonResponse(
  channel: MarketingChannel,
  response: Response,
  maxBytes = DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength
    && /^\d+$/u.test(contentLength)
    && BigInt(contentLength) > BigInt(maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidProviderResponse(channel, response.status);
  }
  if (!response.body) throw invalidProviderResponse(channel, response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response classification.
        }
        throw invalidProviderResponse(channel, response.status);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof ChannelAdapterError) throw error;
    throw invalidProviderResponse(channel, response.status);
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw invalidProviderResponse(channel, response.status);
  }
}
