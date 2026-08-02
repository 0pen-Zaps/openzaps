import "server-only";

import { createHash } from "node:crypto";

import { DISCORD_COMMAND_MANIFEST } from "@/lib/marketing/discord-commands";

/**
 * Hash the same normalized command projection used by the official Discord
 * guild-command reconciler. A receipt for an older projection must never make
 * the current command manifest look live.
 */
export const DISCORD_COMMAND_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(
    DISCORD_COMMAND_MANIFEST.map((command) => ({
      name: command.name,
      description: command.description,
      type: command.type,
      options: command.options ?? [],
    })),
  ), "utf8")
  .digest("hex");
