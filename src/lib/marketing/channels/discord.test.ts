import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  postDiscordBotMessage,
  postDiscordWebhook,
  verifyDiscordInteractionSignature,
  verifyDiscordPublishDestination,
} from "./discord";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function rawEd25519PublicKey(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("hex");
}

const TEST_GUILD_ID = "999888777";
const TEST_CHANNEL_ID = "111222333";

function webhookMetadata(
  webhookId: string,
  guildId = TEST_GUILD_ID,
  channelId = TEST_CHANNEL_ID,
): Response {
  return Response.json({
    id: webhookId,
    type: 1,
    guild_id: guildId,
    channel_id: channelId,
  });
}

function messageReadback(
  messageId: string,
  channelId = TEST_CHANNEL_ID,
  webhookId?: string,
): Response {
  return Response.json({
    id: messageId,
    channel_id: channelId,
    ...(webhookId === undefined ? {} : { webhook_id: webhookId }),
  });
}

describe("Discord outbound adapters", () => {
  it("posts a bounded webhook message with mentions disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(webhookMetadata("12345"))
      .mockResolvedValueOnce(Response.json({ id: "1234567890" }))
      .mockResolvedValueOnce(messageReadback("1234567890", TEST_CHANNEL_ID, "12345"));

    await expect(
      postDiscordWebhook(
        {
          content: "A new tutorial is live: @everyone",
          embeds: [
            {
              title: "Bounded automation",
              description: "What the agent may and may not do.",
              url: "https://www.0xzaps.com",
            },
          ],
          idempotencyKey: "tutorial:bounded:discord",
          username: "OpenZaps",
        },
        {
          webhookUrl: "https://discord.com/api/webhooks/12345/fake-token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      ),
    ).resolves.toEqual({
      channel: "discord",
      transport: "webhook",
      providerMessageId: "1234567890",
      providerUrl:
        "https://discord.com/channels/999888777/111222333/1234567890",
      idempotencyKey: "tutorial:bounded:discord",
    });

    const [metadataUrl, metadataInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(metadataUrl).toBe(
      "https://discord.com/api/v10/webhooks/12345/fake-token",
    );
    expect(metadataInit.method).toBe("GET");
    expect(metadataInit.redirect).toBe("error");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.headers).not.toHaveProperty("idempotency-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      content: "A new tutorial is live: @everyone",
      username: "OpenZaps",
      allowed_mentions: { parse: [] },
    });
    const [readbackUrl, readbackInit] = fetchMock.mock.calls[2] as [
      string,
      RequestInit,
    ];
    expect(readbackUrl).toBe(
      "https://discord.com/api/v10/webhooks/12345/fake-token/messages/1234567890",
    );
    expect(readbackInit).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(readbackInit.headers).not.toHaveProperty("authorization");
  });

  it("uses Discord REST with bot authentication when requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        id: TEST_CHANNEL_ID,
        guild_id: TEST_GUILD_ID,
      }))
      .mockResolvedValueOnce(Response.json({ id: "9876543210" }))
      .mockResolvedValueOnce(messageReadback("9876543210"));

    await expect(
      postDiscordBotMessage(
        { content: "Product update", idempotencyKey: "product:7:discord" },
        {
          botToken: "bot-token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      ),
    ).resolves.toMatchObject({
      transport: "bot",
      providerMessageId: "9876543210",
      providerUrl:
        "https://discord.com/channels/999888777/111222333/9876543210",
    });

    const [metadataUrl, metadataInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(metadataUrl).toBe(
      "https://discord.com/api/v10/channels/111222333",
    );
    expect(metadataInit.method).toBe("GET");
    expect(metadataInit.redirect).toBe("error");
    expect(metadataInit.headers).toMatchObject({ authorization: "Bot bot-token" });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      "https://discord.com/api/v10/channels/111222333/messages",
    );
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bot bot-token" });
    const [readbackUrl, readbackInit] = fetchMock.mock.calls[2] as [
      string,
      RequestInit,
    ];
    expect(readbackUrl).toBe(
      "https://discord.com/api/v10/channels/111222333/messages/9876543210",
    );
    expect(readbackInit).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(readbackInit.headers).toMatchObject({
      authorization: "Bot bot-token",
    });
  });

  it("returns a credential-free structured destination preflight", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(webhookMetadata("12345"));

    await expect(
      verifyDiscordPublishDestination({
        transport: "webhook",
        webhookUrl: "https://discord.com/api/webhooks/12345/private-token",
        guildId: TEST_GUILD_ID,
        channelId: TEST_CHANNEL_ID,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      channel: "discord",
      transport: "webhook",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });
    expect(JSON.stringify(await verifyDiscordPublishDestination({
      transport: "webhook",
      webhookUrl: "https://discord.com/api/webhooks/12345/private-token",
      guildId: TEST_GUILD_ID,
      channelId: TEST_CHANNEL_ID,
      fetchImpl: vi.fn().mockResolvedValueOnce(webhookMetadata("12345")),
    }))).not.toContain("private-token");
  });

  it("authenticates bot destination preflight without returning its binding", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      id: TEST_CHANNEL_ID,
      guild_id: TEST_GUILD_ID,
    }));

    const proof = await verifyDiscordPublishDestination({
      transport: "bot",
      botToken: "private-bot-token",
      guildId: TEST_GUILD_ID,
      channelId: TEST_CHANNEL_ID,
      fetchImpl: fetchMock,
    });

    expect(proof).toEqual({
      schemaVersion: 1,
      channel: "discord",
      transport: "bot",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });
    expect(JSON.stringify(proof)).not.toContain("private-bot-token");
    expect(JSON.stringify(proof)).not.toContain(TEST_GUILD_ID);
    expect(JSON.stringify(proof)).not.toContain(TEST_CHANNEL_ID);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bot private-bot-token",
    });
  });

  it("fails closed when the exact accepted message cannot be read back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(webhookMetadata("12345"))
      .mockResolvedValueOnce(Response.json({ id: "1234567890" }))
      .mockResolvedValueOnce(
        messageReadback("1234567890", "different-channel", "12345"),
      );

    await expect(
      postDiscordWebhook(
        { content: "Bounded post", idempotencyKey: "discord-readback" },
        {
          webhookUrl: "https://discord.com/api/webhooks/12345/private-token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid-response",
      message: "Discord message readback did not match the accepted delivery.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed for an untrusted webhook URL", async () => {
    const fetchMock = vi.fn();
    await expect(
      postDiscordWebhook(
        { content: "No SSRF", idempotencyKey: "unsafe-webhook" },
        {
          webhookUrl: "https://example.com/api/webhooks/123/secret",
          fetchImpl: fetchMock,
        },
      ),
    ).rejects.toMatchObject({
      channel: "discord",
      code: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized content and embed totals before sending", async () => {
    const fetchMock = vi.fn();
    await expect(
      postDiscordWebhook(
        {
          content: "x".repeat(2_001),
          idempotencyKey: "oversized-discord",
        },
        {
          webhookUrl: "https://discord.com/api/webhooks/123/token",
          fetchImpl: fetchMock,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors Discord's JSON retry_after without exposing its error body", async () => {
    const secret = "should-not-appear";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(webhookMetadata("123"))
      .mockResolvedValueOnce(Response.json(
        { message: secret, retry_after: 1.25, global: false },
        { status: 429 },
      ));

    let thrown: unknown;
    try {
      await postDiscordWebhook(
        { content: "Retry safely", idempotencyKey: "discord-rate" },
        {
          webhookUrl: "https://discord.com/api/webhooks/123/token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      channel: "discord",
      code: "rate-limited",
      details: { status: 429, retryAfterMs: 1_250 },
    });
    expect((thrown as Error).message).not.toContain(secret);
  });

  it("times out stalled provider requests and bounds success receipts", async () => {
    const stalledFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("provider timeout detail")),
            { once: true },
          );
        }),
    );
    await expect(
      postDiscordWebhook(
        { content: "Bounded request", idempotencyKey: "discord-timeout" },
        {
          webhookUrl: "https://discord.com/api/webhooks/123/token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: stalledFetch,
          requestTimeoutMs: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "network-error" });

    const oversizedFetch = vi.fn()
      .mockResolvedValueOnce(webhookMetadata("123"))
      .mockResolvedValueOnce(new Response('{"id":"1234567890"}', {
        headers: { "content-length": String(64 * 1_024 + 1) },
      }));
    await expect(
      postDiscordWebhook(
        { content: "Bounded response", idempotencyKey: "discord-response" },
        {
          webhookUrl: "https://discord.com/api/webhooks/123/token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: oversizedFetch,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("blocks wrong or missing webhook destinations before POST without exposing bindings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      webhookMetadata("123", "wrong-guild", TEST_CHANNEL_ID),
    );

    let thrown: unknown;
    try {
      await postDiscordWebhook(
        { content: "Do not publish", idempotencyKey: "wrong-destination" },
        {
          webhookUrl: "https://discordapp.com/api/v9/webhooks/123/private-token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      channel: "discord",
      code: "not-configured",
      message: "Discord destination verification failed.",
    });
    expect((thrown as Error).message).not.toContain(TEST_GUILD_ID);
    expect((thrown as Error).message).not.toContain(TEST_CHANNEL_ID);
    expect((thrown as Error).message).not.toContain("private-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");

    const missingBindingFetch = vi.fn();
    await expect(
      verifyDiscordPublishDestination({
        transport: "webhook",
        webhookUrl: "https://discord.com/api/webhooks/123/private-token",
        guildId: TEST_GUILD_ID,
        fetchImpl: missingBindingFetch,
      }),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(missingBindingFetch).not.toHaveBeenCalled();
  });

  it("blocks a bot channel outside the configured guild before POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: TEST_CHANNEL_ID, guild_id: "222333444" }),
    );

    await expect(
      postDiscordBotMessage(
        { content: "Do not publish", idempotencyKey: "wrong-bot-destination" },
        {
          botToken: "bot-token",
          guildId: TEST_GUILD_ID,
          channelId: TEST_CHANNEL_ID,
          fetchImpl: fetchMock,
        },
      ),
    ).rejects.toMatchObject({
      channel: "discord",
      code: "not-configured",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
  });
});

describe("Discord interaction signatures", () => {
  it("verifies a current Ed25519 signature over timestamp + raw body", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const timestamp = "1800000000";
    const rawBody = '{"type":1}';
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${rawBody}`),
      privateKey,
    ).toString("hex");

    await expect(
      verifyDiscordInteractionSignature(
        { rawBody, signature, timestamp },
        {
          publicKey: rawEd25519PublicKey(publicKey),
          nowMs: Number(timestamp) * 1_000,
        },
      ),
    ).resolves.toBe(true);
  });

  it("fails closed for stale, malformed, or missing signature inputs", async () => {
    const body = { rawBody: "{}", signature: "00".repeat(64), timestamp: "1" };

    await expect(
      verifyDiscordInteractionSignature(body, {
        publicKey: "00".repeat(32),
        nowMs: 1800000000 * 1_000,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordInteractionSignature(
        { ...body, signature: null },
        { publicKey: "00".repeat(32), nowMs: 1_000 },
      ),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordInteractionSignature(body, {
        publicKey: "not-a-public-key",
        nowMs: 1_000,
      }),
    ).resolves.toBe(false);
  });
});
