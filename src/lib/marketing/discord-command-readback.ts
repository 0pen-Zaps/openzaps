import "server-only";

import {
  DiscordCommandReconciliationError,
  readDiscordGuildCommands,
} from "../../../scripts/reconcile-discord-commands.mjs";
import { DISCORD_COMMAND_MANIFEST } from "./discord-commands";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_MANAGED_COMMAND_COUNT = 100;
const MAX_REMOTE_COMMAND_COUNT = 130;

export interface DiscordCommandReadbackCounts {
  desired: number;
  remote: number;
  create: number;
  update: number;
  delete: number;
}

export type DiscordCommandReadback =
  | {
      schemaVersion: 1;
      status: "in_sync" | "drift";
      scope: "configured_application_guild";
      verified: true;
      providerReadbackVerified: true;
      managedCommandsInSync: boolean;
      guildPermissionVisibility: "unchecked";
      liveInvocationVerified: false;
      manifestSha256: string;
      managedReadbackSha256: string;
      counts: DiscordCommandReadbackCounts;
      writesPerformed: false;
    }
  | {
      schemaVersion: 1;
      status: "not_configured";
      scope: "configured_application_guild";
      verified: false;
      providerReadbackVerified: false;
      managedCommandsInSync: false;
      guildPermissionVisibility: "unchecked";
      liveInvocationVerified: false;
      writesPerformed: false;
    };

export interface DiscordCommandReadbackDependencies {
  applicationId?: string;
  guildId?: string;
  botToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandCount(value: unknown, maximum: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum
    ? value
    : null;
}

function readCounts(value: unknown): DiscordCommandReadbackCounts | null {
  if (!isRecord(value)) return null;
  const desired = commandCount(value.desired, MAX_MANAGED_COMMAND_COUNT);
  const remote = commandCount(value.remote, MAX_REMOTE_COMMAND_COUNT);
  const create = commandCount(value.create, MAX_MANAGED_COMMAND_COUNT);
  const update = commandCount(value.update, MAX_MANAGED_COMMAND_COUNT);
  const deleteCount = commandCount(value.delete, MAX_REMOTE_COMMAND_COUNT);
  if (
    desired === null
    || remote === null
    || create === null
    || update === null
    || deleteCount === null
  ) return null;
  return { desired, remote, create, update, delete: deleteCount };
}

function countsAreCoherent(counts: DiscordCommandReadbackCounts): boolean {
  return counts.create <= counts.desired
    && counts.update <= counts.desired - counts.create
    && counts.delete <= counts.remote
    && counts.remote === counts.desired - counts.create + counts.delete;
}

function invalidReadback(): never {
  throw new Error("Discord command readback returned an invalid local result.");
}

/**
 * Read and compare the official guild command list. The invoked wrapper has no
 * apply argument and this helper exposes no mutation option to API callers.
 */
export async function verifyDiscordGuildCommands(
  dependencies: DiscordCommandReadbackDependencies = {},
): Promise<DiscordCommandReadback> {
  try {
    const result: unknown = await readDiscordGuildCommands({
      environment: {
        OPENZAPS_DISCORD_APPLICATION_ID:
          dependencies.applicationId
          ?? process.env.OPENZAPS_DISCORD_APPLICATION_ID,
        OPENZAPS_DISCORD_GUILD_ID:
          dependencies.guildId
          ?? process.env.OPENZAPS_DISCORD_GUILD_ID,
        DISCORD_BOT_TOKEN:
          dependencies.botToken
          ?? process.env.DISCORD_BOT_TOKEN,
      },
      desiredCommands: DISCORD_COMMAND_MANIFEST,
      fetchImpl: dependencies.fetchImpl ?? fetch,
      timeoutMs: dependencies.timeoutMs,
    });
    if (!isRecord(result)) invalidReadback();
    const counts = readCounts(result.counts);
    const manifestSha256 = result.manifestSha256;
    const managedReadbackSha256 = result.managedReadbackSha256;
    if (
      result.schemaVersion !== 1
      || result.mode !== "dry-run"
      || result.scope !== "guild"
      || result.applied !== false
      || result.verified !== true
      || result.providerReadbackVerified !== true
      || typeof result.managedCommandsInSync !== "boolean"
      || result.guildPermissionVisibility !== "unchecked"
      || result.liveInvocationVerified !== false
      || !counts
      || !countsAreCoherent(counts)
      || typeof manifestSha256 !== "string"
      || !SHA256.test(manifestSha256)
      || typeof managedReadbackSha256 !== "string"
      || !SHA256.test(managedReadbackSha256)
    ) invalidReadback();

    const managedCommandsInSync = result.managedCommandsInSync;
    const hashesMatch = manifestSha256 === managedReadbackSha256;
    if (managedCommandsInSync !== hashesMatch) invalidReadback();
    if (
      managedCommandsInSync
        ? counts.create !== 0 || counts.update !== 0
        : counts.create === 0 && counts.update === 0
    ) invalidReadback();

    return {
      schemaVersion: 1,
      status: managedCommandsInSync ? "in_sync" : "drift",
      scope: "configured_application_guild",
      verified: true,
      providerReadbackVerified: true,
      managedCommandsInSync,
      guildPermissionVisibility: "unchecked",
      liveInvocationVerified: false,
      manifestSha256,
      managedReadbackSha256,
      counts,
      writesPerformed: false,
    };
  } catch (error) {
    if (
      error instanceof DiscordCommandReconciliationError
      && error.code === "invalid-environment"
    ) {
      return {
        schemaVersion: 1,
        status: "not_configured",
        scope: "configured_application_guild",
        verified: false,
        providerReadbackVerified: false,
        managedCommandsInSync: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      };
    }
    throw error;
  }
}
