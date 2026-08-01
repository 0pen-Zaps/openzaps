import { describe, expect, it } from "vitest";

import {
  DISCORD_COMMAND_MANIFEST,
  isSupportedDiscordCommandName,
} from "@/lib/marketing/discord-commands";

describe("Discord command manifest", () => {
  it("is the canonical typed definition for the three supported commands", () => {
    expect(DISCORD_COMMAND_MANIFEST.map((command) => command.name)).toEqual([
      "ask",
      "openzaps",
      "status",
    ]);
    expect(DISCORD_COMMAND_MANIFEST).toMatchObject([
      {
        name: "ask",
        type: 1,
        options: [{ name: "question", type: 3, required: true }],
      },
      {
        name: "openzaps",
        type: 1,
        options: [{ name: "question", type: 3, required: false }],
      },
      { name: "status", type: 1 },
    ]);
    expect(Object.isFrozen(DISCORD_COMMAND_MANIFEST)).toBe(true);
  });

  it("derives interaction allow-list checks from the manifest", () => {
    expect(isSupportedDiscordCommandName("ask")).toBe(true);
    expect(isSupportedDiscordCommandName("openzaps")).toBe(true);
    expect(isSupportedDiscordCommandName("status")).toBe(true);
    expect(isSupportedDiscordCommandName("announce")).toBe(false);
    expect(isSupportedDiscordCommandName(1)).toBe(false);
  });
});
