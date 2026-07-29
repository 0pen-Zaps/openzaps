import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { answerMock, verifyMock } = vi.hoisted(() => ({
  answerMock: vi.fn(() => ({ content: "Bounded answer.", topic: "general" })),
  verifyMock: vi.fn(),
}));

vi.mock("@/lib/marketing/channels", () => ({
  verifyDiscordInteractionSignature: verifyMock,
}));

vi.mock("@/lib/marketing/discord-faq", () => ({
  answerOpenZapsFaq: answerMock,
}));

import { POST } from "./route";

function request(body: string, headers?: HeadersInit): Request {
  return new Request("https://www.0xzaps.com/api/marketing/discord/interactions", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_DISCORD_APPLICATION_ID", "123456789");
  vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "987654321");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Discord marketing interactions route", () => {
  it("rejects an oversized body before signature work", async () => {
    const response = await POST(request("{}", {
      "content-length": "1000001",
      "x-signature-ed25519": "not-used",
      "x-signature-timestamp": "1",
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Interaction request too large." });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures without parsing or answering", async () => {
    verifyMock.mockResolvedValue(false);

    const response = await POST(request("{", {
      "x-signature-ed25519": "invalid",
      "x-signature-timestamp": "1",
    }));

    expect(response.status).toBe(401);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("handles a signed ping and rejects malformed signed JSON", async () => {
    verifyMock.mockResolvedValue(true);

    const ping = await POST(request(JSON.stringify({
      type: 1,
      application_id: "123456789",
      guild_id: "987654321",
    })));
    const malformed = await POST(request("{"));

    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ type: 1 });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid interaction body." });
  });

  it("accepts Discord's endpoint-validation PING when guild_id is omitted", async () => {
    verifyMock.mockResolvedValue(true);

    const response = await POST(request(JSON.stringify({
      type: 1,
      application_id: "123456789",
    })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("answers only supported signed commands with mentions disabled", async () => {
    verifyMock.mockResolvedValue(true);
    const body = JSON.stringify({
      type: 2,
      application_id: "123456789",
      guild_id: "987654321",
      data: {
        name: "ask",
        options: [{ name: "question", value: "What is a Zap?" }],
      },
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(answerMock).toHaveBeenCalledWith("What is a Zap?");
    expect(await response.json()).toEqual({
      type: 4,
      data: {
        content: "Bounded answer.",
        allowed_mentions: { parse: [] },
      },
    });
  });

  it("returns an empty 403 for signed PINGs or commands outside the configured app and guild", async () => {
    verifyMock.mockResolvedValue(true);

    const wrongApplication = await POST(request(JSON.stringify({
      type: 1,
      application_id: "111111111",
      guild_id: "987654321",
    })));
    const wrongGuild = await POST(request(JSON.stringify({
      type: 2,
      application_id: "123456789",
      guild_id: "222222222",
      data: { name: "ask" },
    })));

    expect(wrongApplication.status).toBe(403);
    expect(await wrongApplication.text()).toBe("");
    expect(wrongApplication.headers.get("cache-control")).toBe("private, no-store");
    expect(wrongGuild.status).toBe(403);
    expect(await wrongGuild.text()).toBe("");
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("returns an empty 403 when the interaction target is not configured", async () => {
    verifyMock.mockResolvedValue(true);
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "");

    const response = await POST(request(JSON.stringify({
      type: 1,
      application_id: "123456789",
      guild_id: "987654321",
    })));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });
});
