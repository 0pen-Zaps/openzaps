import { afterEach, describe, expect, it, vi } from "vitest";

import { DISCORD_COMMAND_MANIFEST } from "@/lib/marketing/discord-commands";

vi.mock("server-only", () => ({}));

import { verifyDiscordGuildCommands } from "@/lib/marketing/discord-command-readback";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "234567890123456789";
const BOT_TOKEN = "discord-bot-token-value-1234567890";

function remoteManifest() {
  return DISCORD_COMMAND_MANIFEST.map((command, index) => ({
    ...command,
    id: String(345678901234567890n + BigInt(index)),
    application_id: APPLICATION_ID,
    guild_id: GUILD_ID,
    version: String(456789012345678900n + BigInt(index)),
  }));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Discord command provider readback", () => {
  it("returns an honest not-configured result without a provider call", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: "",
      fetchImpl,
    })).resolves.toEqual({
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
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses exactly one official GET and returns only bounded sync evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(remoteManifest()),
    );

    const result = await verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "in_sync",
      verified: true,
      providerReadbackVerified: true,
      managedCommandsInSync: true,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      counts: { desired: 3, remote: 3, create: 0, update: 0, delete: 0 },
      writesPerformed: false,
    });
    if (result.status !== "in_sync") throw new Error("Expected an in-sync readback.");
    expect(result.managedReadbackSha256).toBe(result.manifestSha256);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
    );
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(["POST", "PATCH", "PUT", "DELETE"]).not.toContain(init?.method);
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(APPLICATION_ID);
    expect(JSON.stringify(result)).not.toContain(GUILD_ID);
  });

  it("reports managed drift without exposing provider command content", async () => {
    const remote = remoteManifest();
    remote[0] = { ...remote[0], description: "Provider-side drift" };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(remote));

    const result = await verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "drift",
      verified: true,
      managedCommandsInSync: false,
      counts: { desired: 3, remote: 3, create: 0, update: 1, delete: 0 },
      writesPerformed: false,
    });
    expect(JSON.stringify(result)).not.toContain("Provider-side drift");
  });

  it("tolerates valid unrelated USER and MESSAGE command names", async () => {
    const remote = [
      ...remoteManifest(),
      {
        name: "Inspect User",
        description: "",
        type: 2,
        id: "567890123456789012",
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
      },
      {
        name: "Report Message",
        description: "",
        type: 3,
        id: "678901234567890123",
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(remote));

    const result = await verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "in_sync",
      managedCommandsInSync: true,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      counts: { desired: 3, remote: 5, create: 0, update: 0, delete: 2 },
      writesPerformed: false,
    });
    expect(JSON.stringify(result)).not.toContain("Inspect User");
    expect(JSON.stringify(result)).not.toContain("Report Message");
  });

  it("accepts Discord's full per-type guild command capacity", async () => {
    const remote: Array<Record<string, unknown>> = [...remoteManifest()];
    for (let index = 0; index < 97; index += 1) {
      remote.push({
        name: `extra_${index}`,
        description: "Unrelated chat-input command",
        type: 1,
        id: String(700000000000000000n + BigInt(index)),
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
        version: String(710000000000000000n + BigInt(index)),
      });
    }
    for (let index = 0; index < 15; index += 1) {
      remote.push({
        name: `Inspect User ${index}`,
        description: "",
        type: 2,
        id: String(720000000000000000n + BigInt(index)),
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
      });
      remote.push({
        name: `Report Message ${index}`,
        description: "",
        type: 3,
        id: String(730000000000000000n + BigInt(index)),
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID,
      });
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(remote));

    await expect(verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
      fetchImpl,
    })).resolves.toMatchObject({
      status: "in_sync",
      managedCommandsInSync: true,
      counts: { desired: 3, remote: 130, create: 0, update: 0, delete: 127 },
      writesPerformed: false,
    });
  });

  it("reports manifest sync without claiming command permission visibility", async () => {
    const remote = remoteManifest().map((command) => ({
      ...command,
      default_member_permissions: "0",
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(remote));

    await expect(verifyDiscordGuildCommands({
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
      fetchImpl,
    })).resolves.toMatchObject({
      status: "in_sync",
      managedCommandsInSync: true,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      writesPerformed: false,
    });
  });
});
