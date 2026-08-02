import { describe, expect, it, vi } from "vitest";

import { DISCORD_COMMAND_MANIFEST } from "@/lib/marketing/discord-commands";

vi.mock("server-only", () => ({}));

import { DISCORD_COMMAND_MANIFEST_SHA256 } from "@/lib/marketing/discord-command-manifest";

describe("Discord command manifest evidence", () => {
  it("binds receipts to the reconciler's canonical command projection", async () => {
    const { verifyGuildCommandReadback } = await import(
      "../../../scripts/reconcile-discord-commands.mjs"
    );
    const applicationId = "123456789012345678";
    const guildId = "234567890123456789";
    const remote = DISCORD_COMMAND_MANIFEST.map((command, index) => ({
      ...command,
      id: String(345678901234567890n + BigInt(index)),
      application_id: applicationId,
      guild_id: guildId,
    }));

    const result = verifyGuildCommandReadback({
      desiredValue: DISCORD_COMMAND_MANIFEST,
      remoteValue: remote,
      applicationId,
      guildId,
    });

    expect(DISCORD_COMMAND_MANIFEST_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.manifestSha256).toBe(DISCORD_COMMAND_MANIFEST_SHA256);
    expect(result.managedReadbackSha256).toBe(DISCORD_COMMAND_MANIFEST_SHA256);
  });
});
