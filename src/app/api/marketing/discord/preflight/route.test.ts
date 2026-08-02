import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verifyDestination: vi.fn(),
  verifyCommands: vi.fn(),
}));

vi.mock("@/lib/marketing/channels/discord", () => ({
  verifyDiscordPublishDestination: mocks.verifyDestination,
}));

vi.mock("@/lib/marketing/discord-command-readback", () => ({
  verifyDiscordGuildCommands: mocks.verifyCommands,
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
    expect(mocks.verifyCommands).not.toHaveBeenCalled();
  });

  it("returns read-only destination and official command proofs", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockResolvedValue({
      schemaVersion: 1,
      channel: "discord",
      transport: "webhook",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });
    mocks.verifyCommands.mockResolvedValue({
      schemaVersion: 1,
      status: "in_sync",
      scope: "configured_application_guild",
      verified: true,
      providerReadbackVerified: true,
      managedCommandsInSync: true,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      manifestSha256: "a".repeat(64),
      managedReadbackSha256: "a".repeat(64),
      counts: { desired: 3, remote: 3, create: 0, update: 0, delete: 0 },
      writesPerformed: false,
    });

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      service: "OpenZaps Discord destination and command-manifest preflight",
      destination: {
        schemaVersion: 1,
        channel: "discord",
        transport: "webhook",
        scope: "configured_guild_channel",
        verified: true,
        mutationsPerformed: false,
      },
      commandReadback: {
        schemaVersion: 1,
        status: "in_sync",
        scope: "configured_application_guild",
        verified: true,
        providerReadbackVerified: true,
        managedCommandsInSync: true,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        manifestSha256: "a".repeat(64),
        managedReadbackSha256: "a".repeat(64),
        counts: { desired: 3, remote: 3, create: 0, update: 0, delete: 0 },
        writesPerformed: false,
      },
      writesPerformed: false,
    });
    expect(raw).not.toContain("operator-secret");
    expect(mocks.verifyCommands).toHaveBeenCalledOnce();
  });

  it("keeps a missing command credential honest without degrading destination health", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockResolvedValue({
      schemaVersion: 1,
      channel: "discord",
      transport: "webhook",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });
    mocks.verifyCommands.mockResolvedValue({
      schemaVersion: 1,
      status: "not_configured",
      scope: "configured_application_guild",
      verified: false,
      providerReadbackVerified: false,
      managedCommandsInSync: false,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      writesPerformed: false,
    });

    const response = await GET(request("operator-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      destination: { verified: true },
      commandReadback: {
        status: "not_configured",
        verified: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      },
      writesPerformed: false,
    });
  });

  it("reports command-provider failure separately from a healthy destination", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyDestination.mockResolvedValue({
      schemaVersion: 1,
      channel: "discord",
      transport: "webhook",
      scope: "configured_guild_channel",
      verified: true,
      mutationsPerformed: false,
    });
    mocks.verifyCommands.mockRejectedValue(new Error("discord-command-secret"));

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toMatchObject({
      destination: { verified: true },
      commandReadback: {
        status: "unavailable",
        verified: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      },
      writesPerformed: false,
    });
    expect(raw).not.toContain("discord-command-secret");
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
    expect(mocks.verifyCommands).not.toHaveBeenCalled();
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
