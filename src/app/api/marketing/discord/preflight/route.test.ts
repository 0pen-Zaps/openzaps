import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verifyDestination: vi.fn(),
}));

vi.mock("@/lib/marketing/channels/discord", () => ({
  verifyDiscordPublishDestination: mocks.verifyDestination,
}));

import { GET } from "./route";

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/discord/preflight", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing Discord destination preflight route", () => {
  it("requires the private operator token without calling Discord", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ error: "Unauthorized." });
    expect(mocks.verifyDestination).not.toHaveBeenCalled();
  });

  it("returns only a read-only, credential-free destination proof", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockResolvedValue({
      schemaVersion: 1,
      channel: "discord",
      transport: "webhook",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      service: "OpenZaps Discord activation preflight",
      destination: {
        schemaVersion: 1,
        channel: "discord",
        transport: "webhook",
        scope: "configured_guild_channel",
        verified: true,
        mutationsPerformed: false,
      },
      commandReadback: "not_checked",
      writesPerformed: false,
    });
    expect(raw).not.toContain("operator-secret");
  });

  it("keeps command activation distinct and sanitizes destination failures", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockRejectedValue(
      new Error("discord-provider-secret"),
    );

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      error: "Discord destination could not be verified.",
      destination: { verified: false },
      commandReadback: "not_checked",
      writesPerformed: false,
    });
    expect(raw).not.toContain("discord-provider-secret");
  });

  it("preserves only a bounded provider retry window", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockRejectedValue(
      new ChannelAdapterError(
        "discord",
        "rate-limited",
        "Discord is rate limiting requests.",
        { retryAfterMs: 1_500 },
      ),
    );

    const response = await GET(request("operator-secret"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });
});
