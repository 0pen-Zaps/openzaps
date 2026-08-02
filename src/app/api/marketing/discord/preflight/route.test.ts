import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readInvocations: vi.fn(),
  verifyDestination: vi.fn(),
  verifyCommands: vi.fn(),
}));

vi.mock("@/lib/marketing/channels/discord", () => ({
  verifyDiscordPublishDestination: mocks.verifyDestination,
}));

vi.mock("@/lib/marketing/discord-command-readback", () => ({
  verifyDiscordGuildCommands: mocks.verifyCommands,
}));

vi.mock("@/lib/marketing/discord-command-invocation-receipt-server", () => ({
  getDiscordCommandInvocationReadback: mocks.readInvocations,
}));

function invocationReadback(manifestSha256 = "a".repeat(64)) {
  return {
    schemaVersion: 1,
    status: "current_manifest_seen",
    scope: "privacy_safe_configured_target_receipts",
    manifestSha256,
    commands: [
      { command: "ask", observed: true, firstVerifiedAt: "2026-08-02T07:58:00.000Z" },
      { command: "openzaps", observed: false, firstVerifiedAt: null },
      { command: "status", observed: false, firstVerifiedAt: null },
    ],
    anyVerifiedInvocationObserved: true,
    allCommandsObserved: false,
    responseDeliveryVerified: false,
    uniqueInvocationsCounted: false,
    writesPerformed: false,
  } as const;
}

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
    expect(mocks.readInvocations).not.toHaveBeenCalled();
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
    mocks.readInvocations.mockResolvedValue(invocationReadback());

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
      invocationReadback: invocationReadback(),
      commandInvocationManifestConsistency: "matched",
      writesPerformed: false,
    });
    expect(raw).not.toContain("operator-secret");
    expect(mocks.verifyCommands).toHaveBeenCalledOnce();
    expect(mocks.readInvocations).toHaveBeenCalledOnce();
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
    mocks.readInvocations.mockResolvedValue({
      ...invocationReadback(),
      status: "not_observed",
      commands: invocationReadback().commands.map((entry) => ({
        ...entry,
        observed: false,
        firstVerifiedAt: null,
      })),
      anyVerifiedInvocationObserved: false,
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
      invocationReadback: {
        status: "not_observed",
        anyVerifiedInvocationObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
      commandInvocationManifestConsistency: "not_checked",
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
    mocks.readInvocations.mockRejectedValue(new Error("receipt-store-secret"));

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
      invocationReadback: {
        schemaVersion: 1,
        status: "unavailable",
        scope: "privacy_safe_configured_target_receipts",
        manifestSha256: null,
        commands: [],
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
      commandInvocationManifestConsistency: "not_checked",
      writesPerformed: false,
    });
    expect(raw).not.toContain("discord-command-secret");
    expect(raw).not.toContain("receipt-store-secret");
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
      invocationReadback: "not_checked",
      commandInvocationManifestConsistency: "not_checked",
      writesPerformed: false,
    });
    expect(raw).not.toContain("discord-provider-secret");
    expect(mocks.verifyCommands).not.toHaveBeenCalled();
    expect(mocks.readInvocations).not.toHaveBeenCalled();
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

  it("fails the invocation lane closed instead of emitting contradictory manifest hashes", async () => {
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
    mocks.readInvocations.mockResolvedValue(invocationReadback("b".repeat(64)));

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toMatchObject({
      destination: { verified: true },
      commandReadback: {
        status: "in_sync",
        manifestSha256: "a".repeat(64),
      },
      invocationReadback: {
        schemaVersion: 1,
        status: "unavailable",
        scope: "privacy_safe_configured_target_receipts",
        manifestSha256: null,
        commands: [],
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
      commandInvocationManifestConsistency: "mismatch",
      writesPerformed: false,
    });
    expect(raw).not.toContain("b".repeat(64));
    expect(mocks.verifyCommands).toHaveBeenCalledOnce();
    expect(mocks.readInvocations).toHaveBeenCalledOnce();
  });
});
