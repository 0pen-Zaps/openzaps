import "server-only";

import { verifyKey } from "discord-interactions";

import {
  ChannelAdapterError,
  assertIdempotencyKey,
  parseRetryAfterMs,
  providerError,
  readBoundedJsonResponse,
  requireServerSecret,
  safelyFetch,
  type ChannelFetch,
} from "./shared";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_CONTENT_MAX = 2_000;
const DISCORD_EMBEDS_MAX = 10;
const DISCORD_EMBED_TOTAL_MAX = 6_000;
const DISCORD_INTERACTION_BODY_MAX_BYTES = 1_000_000;
const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1_000;
const DISCORD_ID = /^\d{1,30}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const HEX_64_BYTES = /^[0-9a-f]{128}$/i;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  author?: { name: string; url?: string };
}

export interface DiscordPublishInput {
  content?: string;
  embeds?: DiscordEmbed[];
  idempotencyKey: string;
  username?: string;
  avatarUrl?: string;
}

export interface DiscordPublishResult {
  channel: "discord";
  transport: "webhook" | "bot";
  providerMessageId: string;
  idempotencyKey: string;
}

interface DiscordDependencies {
  fetchImpl?: ChannelFetch;
  nowMs?: number;
  requestTimeoutMs?: number;
}

export interface DiscordWebhookDependencies extends DiscordDependencies {
  webhookUrl?: string;
  guildId?: string;
  channelId?: string;
}

export interface DiscordBotDependencies extends DiscordDependencies {
  botToken?: string;
  guildId?: string;
  channelId?: string;
}

export interface DiscordPublishDependencies
  extends DiscordWebhookDependencies,
    DiscordBotDependencies {
  transport?: "webhook" | "bot";
}

interface DiscordMessageResponse {
  id?: unknown;
}

interface DiscordWebhookMetadata {
  id?: unknown;
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
}

interface DiscordChannelMetadata {
  id?: unknown;
  guild_id?: unknown;
}

interface ValidatedDiscordWebhookUrls {
  webhookId: string;
  metadataUrl: string;
  executeUrl: string;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function assertOptionalText(
  value: string | undefined,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return 0;
  const length = codePointLength(value);
  if (length > maximum) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      `${label} must be at most ${maximum} characters.`,
    );
  }
  return length;
}

function assertUrl(value: string | undefined, label: string): void {
  if (value === undefined) return;
  try {
    const url = new URL(value);
    if (
      value.length > 2_048 ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      throw new Error();
    }
  } catch {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      `${label} must be an HTTP URL.`,
    );
  }
}

function validateDiscordInput(input: DiscordPublishInput): void {
  assertIdempotencyKey("discord", input.idempotencyKey);
  const contentLength = assertOptionalText(
    input.content,
    DISCORD_CONTENT_MAX,
    "Discord message content",
  );
  assertOptionalText(input.username, 80, "Discord webhook username");
  if (input.username !== undefined && !input.username.trim()) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      "Discord webhook username must not be empty.",
    );
  }
  assertUrl(input.avatarUrl, "Discord webhook avatarUrl");

  const embeds = input.embeds ?? [];
  if (embeds.length > DISCORD_EMBEDS_MAX) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      `Discord messages support at most ${DISCORD_EMBEDS_MAX} embeds.`,
    );
  }
  if (contentLength === 0 && embeds.length === 0) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      "Discord content or an embed is required.",
    );
  }

  let embedCharacters = 0;
  for (const embed of embeds) {
    embedCharacters += assertOptionalText(
      embed.title,
      256,
      "Discord embed title",
    );
    embedCharacters += assertOptionalText(
      embed.description,
      4_096,
      "Discord embed description",
    );
    assertUrl(embed.url, "Discord embed URL");
    if (
      embed.color !== undefined &&
      (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)
    ) {
      throw new ChannelAdapterError(
        "discord",
        "invalid-input",
        "Discord embed color must be an integer from 0 to 16777215.",
      );
    }
    const fields = embed.fields ?? [];
    if (fields.length > 25) {
      throw new ChannelAdapterError(
        "discord",
        "invalid-input",
        "Discord embeds support at most 25 fields.",
      );
    }
    for (const field of fields) {
      if (!field.name.trim() || !field.value.trim()) {
        throw new ChannelAdapterError(
          "discord",
          "invalid-input",
          "Discord embed field names and values must not be empty.",
        );
      }
      embedCharacters += assertOptionalText(
        field.name,
        256,
        "Discord embed field name",
      );
      embedCharacters += assertOptionalText(
        field.value,
        1_024,
        "Discord embed field value",
      );
    }
    embedCharacters += assertOptionalText(
      embed.footer?.text,
      2_048,
      "Discord embed footer",
    );
    embedCharacters += assertOptionalText(
      embed.author?.name,
      256,
      "Discord embed author",
    );
    assertUrl(embed.author?.url, "Discord embed author URL");
  }

  if (embedCharacters > DISCORD_EMBED_TOTAL_MAX) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-input",
      `Discord embed text must total at most ${DISCORD_EMBED_TOTAL_MAX} characters.`,
    );
  }
}

function discordBody(input: DiscordPublishInput, includeWebhookIdentity: boolean) {
  return {
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.embeds === undefined ? {} : { embeds: input.embeds }),
    ...(includeWebhookIdentity && input.username !== undefined
      ? { username: input.username }
      : {}),
    ...(includeWebhookIdentity && input.avatarUrl !== undefined
      ? { avatar_url: input.avatarUrl }
      : {}),
    // Marketing posts never ping roles, users, or @everyone. Discord still
    // renders the text, but it cannot turn model output into a notification.
    allowed_mentions: { parse: [] as string[] },
  };
}

function validatedWebhookUrls(raw: string): ValidatedDiscordWebhookUrls {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChannelAdapterError(
      "discord",
      "not-configured",
      "discord publishing is not configured.",
    );
  }
  const allowedHost =
    url.hostname === "discord.com" ||
    url.hostname === "discordapp.com";
  const match = url.pathname.match(
    /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)$/,
  );
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !match
  ) {
    throw new ChannelAdapterError(
      "discord",
      "not-configured",
      "discord publishing is not configured.",
    );
  }
  const metadataUrl =
    `${DISCORD_API_BASE}/webhooks/${match[1]}/${match[2]}`;
  const executeUrl = new URL(metadataUrl);
  executeUrl.searchParams.set("wait", "true");
  return {
    webhookId: match[1],
    metadataUrl,
    executeUrl: executeUrl.toString(),
  };
}

function requiredDiscordDestinationId(
  value: string | undefined,
): string {
  if (!value || !DISCORD_ID.test(value)) {
    throw new ChannelAdapterError(
      "discord",
      "not-configured",
      "discord publishing is not configured.",
    );
  }
  return value;
}

function discordDestinationError(): ChannelAdapterError {
  return new ChannelAdapterError(
    "discord",
    "not-configured",
    "Discord destination verification failed.",
  );
}

async function discordProviderError(
  response: Response,
  nowMs?: number,
): Promise<ChannelAdapterError> {
  let jsonRetryAfterMs: number | undefined;
  if (response.status === 429) {
    try {
      const body = await readBoundedJsonResponse(
        "discord",
        response.clone(),
      ) as { retry_after?: unknown };
      if (
        typeof body.retry_after === "number" &&
        Number.isFinite(body.retry_after) &&
        body.retry_after >= 0
      ) {
        jsonRetryAfterMs = Math.ceil(body.retry_after * 1_000);
      }
    } catch {
      // The standard Retry-After header remains the safe fallback.
    }
  }
  return providerError(
    "discord",
    response,
    nowMs,
    jsonRetryAfterMs ??
      parseRetryAfterMs(response.headers.get("retry-after"), nowMs),
  );
}

async function parseDiscordResult(
  response: Response,
  input: DiscordPublishInput,
  transport: DiscordPublishResult["transport"],
): Promise<DiscordPublishResult> {
  const payload = await readBoundedJsonResponse(
    "discord",
    response,
  ) as DiscordMessageResponse;
  if (typeof payload.id !== "string" || !DISCORD_ID.test(payload.id)) {
    throw new ChannelAdapterError(
      "discord",
      "invalid-response",
      "Discord returned an invalid response.",
      { status: response.status },
    );
  }
  return {
    channel: "discord",
    transport,
    providerMessageId: payload.id,
    idempotencyKey: input.idempotencyKey,
  };
}

async function verifyDiscordWebhookDestination(
  dependencies: DiscordWebhookDependencies,
): Promise<void> {
  const webhook = validatedWebhookUrls(
    requireServerSecret(
      "discord",
      "DISCORD_MARKETING_WEBHOOK_URL",
      dependencies.webhookUrl,
    ),
  );
  const guildId = requiredDiscordDestinationId(
    dependencies.guildId ?? process.env.OPENZAPS_DISCORD_GUILD_ID,
  );
  const channelId = requiredDiscordDestinationId(
    dependencies.channelId ?? process.env.DISCORD_MARKETING_CHANNEL_ID,
  );
  const response = await safelyFetch(
    "discord",
    dependencies.fetchImpl ?? fetch,
    webhook.metadataUrl,
    {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    },
    dependencies.requestTimeoutMs,
  );
  if (!response.ok) throw await discordProviderError(response, dependencies.nowMs);
  const metadata = await readBoundedJsonResponse(
    "discord",
    response,
  ) as DiscordWebhookMetadata;
  if (
    metadata.type !== 1 ||
    metadata.id !== webhook.webhookId ||
    metadata.guild_id !== guildId ||
    metadata.channel_id !== channelId
  ) {
    throw discordDestinationError();
  }
}

async function verifyDiscordBotDestination(
  dependencies: DiscordBotDependencies,
): Promise<void> {
  const token = requireServerSecret(
    "discord",
    "DISCORD_BOT_TOKEN",
    dependencies.botToken,
  );
  const guildId = requiredDiscordDestinationId(
    dependencies.guildId ?? process.env.OPENZAPS_DISCORD_GUILD_ID,
  );
  const channelId = requiredDiscordDestinationId(
    dependencies.channelId ?? process.env.DISCORD_MARKETING_CHANNEL_ID,
  );
  const response = await safelyFetch(
    "discord",
    dependencies.fetchImpl ?? fetch,
    `${DISCORD_API_BASE}/channels/${channelId}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bot ${token}`,
      },
      cache: "no-store",
      redirect: "error",
    },
    dependencies.requestTimeoutMs,
  );
  if (!response.ok) throw await discordProviderError(response, dependencies.nowMs);
  const metadata = await readBoundedJsonResponse(
    "discord",
    response,
  ) as DiscordChannelMetadata;
  if (metadata.id !== channelId || metadata.guild_id !== guildId) {
    throw discordDestinationError();
  }
}

/**
 * Resolve and verify the configured Discord destination without writing.
 * Provider metadata is bounded and discarded; no webhook URL, token, guild,
 * or channel identifier is returned to callers.
 */
export async function verifyDiscordPublishDestination(
  dependencies: DiscordPublishDependencies = {},
): Promise<void> {
  const transport =
    dependencies.transport ??
    (dependencies.webhookUrl || process.env.DISCORD_MARKETING_WEBHOOK_URL
      ? "webhook"
      : "bot");
  return transport === "webhook"
    ? verifyDiscordWebhookDestination(dependencies)
    : verifyDiscordBotDestination(dependencies);
}

export async function postDiscordWebhook(
  input: DiscordPublishInput,
  dependencies: DiscordWebhookDependencies = {},
): Promise<DiscordPublishResult> {
  validateDiscordInput(input);
  const webhook = validatedWebhookUrls(
    requireServerSecret(
      "discord",
      "DISCORD_MARKETING_WEBHOOK_URL",
      dependencies.webhookUrl,
    ),
  );
  await verifyDiscordWebhookDestination(dependencies);
  const response = await safelyFetch(
    "discord",
    dependencies.fetchImpl ?? fetch,
    webhook.executeUrl,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(discordBody(input, true)),
      cache: "no-store",
      redirect: "error",
    },
    dependencies.requestTimeoutMs,
  );
  if (!response.ok) throw await discordProviderError(response, dependencies.nowMs);
  return parseDiscordResult(response, input, "webhook");
}

export async function postDiscordBotMessage(
  input: DiscordPublishInput,
  dependencies: DiscordBotDependencies = {},
): Promise<DiscordPublishResult> {
  validateDiscordInput(input);
  const token = requireServerSecret(
    "discord",
    "DISCORD_BOT_TOKEN",
    dependencies.botToken,
  );
  const channelId =
    dependencies.channelId ?? process.env.DISCORD_MARKETING_CHANNEL_ID;
  requiredDiscordDestinationId(channelId);
  await verifyDiscordBotDestination(dependencies);
  const response = await safelyFetch(
    "discord",
    dependencies.fetchImpl ?? fetch,
    `${DISCORD_API_BASE}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(discordBody(input, false)),
      cache: "no-store",
      redirect: "error",
    },
    dependencies.requestTimeoutMs,
  );
  if (!response.ok) throw await discordProviderError(response, dependencies.nowMs);
  return parseDiscordResult(response, input, "bot");
}

export function postDiscordMessage(
  input: DiscordPublishInput,
  dependencies: DiscordPublishDependencies = {},
): Promise<DiscordPublishResult> {
  const transport =
    dependencies.transport ??
    (dependencies.webhookUrl || process.env.DISCORD_MARKETING_WEBHOOK_URL
      ? "webhook"
      : "bot");
  return transport === "webhook"
    ? postDiscordWebhook(input, dependencies)
    : postDiscordBotMessage(input, dependencies);
}

export interface DiscordInteractionSignatureInput {
  rawBody: string | Uint8Array | ArrayBuffer;
  signature: string | null;
  timestamp: string | null;
}

export interface DiscordInteractionSignatureDependencies {
  publicKey?: string;
  nowMs?: number;
  maxAgeMs?: number;
}

function interactionBodyByteLength(
  rawBody: DiscordInteractionSignatureInput["rawBody"],
): number {
  if (typeof rawBody === "string") return new TextEncoder().encode(rawBody).byteLength;
  return rawBody.byteLength;
}

/**
 * Verify Discord's Ed25519 interaction signature and reject stale replays.
 * Invalid or missing configuration always returns false.
 */
export async function verifyDiscordInteractionSignature(
  input: DiscordInteractionSignatureInput,
  dependencies: DiscordInteractionSignatureDependencies = {},
): Promise<boolean> {
  const publicKey =
    dependencies.publicKey ?? process.env.DISCORD_APPLICATION_PUBLIC_KEY;
  if (
    !publicKey ||
    !HEX_32_BYTES.test(publicKey) ||
    !input.signature ||
    !HEX_64_BYTES.test(input.signature) ||
    !input.timestamp ||
    !/^\d{1,15}$/.test(input.timestamp) ||
    interactionBodyByteLength(input.rawBody) > DISCORD_INTERACTION_BODY_MAX_BYTES
  ) {
    return false;
  }

  const timestampMs = Number(input.timestamp) * 1_000;
  const maxAgeMs =
    dependencies.maxAgeMs ?? DISCORD_SIGNATURE_MAX_AGE_MS;
  if (
    !Number.isFinite(timestampMs) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    Math.abs((dependencies.nowMs ?? Date.now()) - timestampMs) > maxAgeMs
  ) {
    return false;
  }

  try {
    return await verifyKey(
      input.rawBody,
      input.signature,
      input.timestamp,
      publicKey,
    );
  } catch {
    return false;
  }
}
