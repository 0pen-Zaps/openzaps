#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MANIFEST_URL = new URL(
  "../src/lib/marketing/discord-commands.json",
  import.meta.url,
);
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_REQUEST_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DISCORD_SNOWFLAKE = /^[1-9]\d{16,19}$/u;
const DISCORD_BOT_TOKEN = /^[A-Za-z0-9._-]{20,256}$/u;
const MANAGED_COMMAND_NAME = /^[a-z0-9_-]{1,32}$/u;
const REMOTE_CHAT_INPUT_COMMAND_NAME =
  /^[-_'\p{L}\p{N}\p{Script=Devanagari}\p{Script=Thai}]{1,32}$/u;
const COMMAND_TYPES = new Set([1, 2, 3]);
const COMMAND_TYPE_LIMITS = new Map([[1, 100], [2, 15], [3, 15]]);
const MAX_REMOTE_COMMANDS = 130;
const DESIRED_COMMAND_KEYS = new Set(["name", "description", "type", "options"]);
const DESIRED_OPTION_KEYS = new Set([
  "name",
  "description",
  "type",
  "required",
]);

export class DiscordCommandReconciliationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DiscordCommandReconciliationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DiscordCommandReconciliationError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function assertAllowedKeys(record, allowed, label) {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail("invalid-manifest", `Discord command manifest has an unsupported ${label} field.`);
  }
}

function requiredBoundedText(value, maximum, label) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || codePointLength(value) > maximum
  ) {
    fail("invalid-manifest", `Discord command manifest has an invalid ${label}.`);
  }
  return value;
}

/**
 * Validate and clone the canonical command payload before any provider call.
 *
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
export function validateDesiredCommands(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    fail("invalid-manifest", "Discord command manifest must contain 1 to 100 commands.");
  }

  const commandNames = new Set();
  return value.map((rawCommand) => {
    if (!isRecord(rawCommand)) {
      fail("invalid-manifest", "Discord command manifest contains an invalid command.");
    }
    assertAllowedKeys(rawCommand, DESIRED_COMMAND_KEYS, "command");
    const name = requiredBoundedText(rawCommand.name, 32, "command name");
    const description = requiredBoundedText(
      rawCommand.description,
      100,
      "command description",
    );
    if (!MANAGED_COMMAND_NAME.test(name) || commandNames.has(name) || rawCommand.type !== 1) {
      fail("invalid-manifest", "Discord command manifest command identity is invalid.");
    }
    commandNames.add(name);

    const rawOptions = rawCommand.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > 25) {
      fail("invalid-manifest", "Discord command manifest options are invalid.");
    }
    const optionNames = new Set();
    let foundOptional = false;
    const options = rawOptions.map((rawOption) => {
      if (!isRecord(rawOption)) {
        fail("invalid-manifest", "Discord command manifest contains an invalid option.");
      }
      assertAllowedKeys(rawOption, DESIRED_OPTION_KEYS, "option");
      const optionName = requiredBoundedText(rawOption.name, 32, "option name");
      const optionDescription = requiredBoundedText(
        rawOption.description,
        100,
        "option description",
      );
      if (
        !MANAGED_COMMAND_NAME.test(optionName)
        || optionNames.has(optionName)
        || rawOption.type !== 3
        || typeof rawOption.required !== "boolean"
        || (foundOptional && rawOption.required)
      ) {
        fail("invalid-manifest", "Discord command manifest option is invalid.");
      }
      optionNames.add(optionName);
      foundOptional ||= !rawOption.required;
      return {
        name: optionName,
        description: optionDescription,
        type: 3,
        required: rawOption.required,
      };
    });

    return {
      name,
      description,
      type: 1,
      ...(options.length === 0 ? {} : { options }),
    };
  });
}

/** @returns {Promise<Array<Record<string, unknown>>>} */
export async function loadDesiredCommands() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(MANIFEST_URL, "utf8"));
  } catch {
    fail("invalid-manifest", "Discord command manifest could not be read.");
  }
  return validateDesiredCommands(parsed);
}

function commandKey(type, name) {
  return `${type}:${name}`;
}

function validRemoteCommandName(type, name) {
  if (
    typeof name !== "string"
    || codePointLength(name) < 1
    || codePointLength(name) > 32
  ) return false;
  if (type === 1) {
    return REMOTE_CHAT_INPUT_COMMAND_NAME.test(name)
      && name === name.toLocaleLowerCase();
  }
  return true;
}

function displayCommand(type, name) {
  if (type === 1) return `/${name}`;
  return `${type === 2 ? "user" : "message"}:${name}`;
}

function parseRemoteCommands(value) {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_COMMANDS) {
    fail("invalid-response", "Discord returned an invalid command list.");
  }
  const commands = new Map();
  const typeCounts = new Map([[1, 0], [2, 0], [3, 0]]);
  for (const rawCommand of value) {
    if (!isRecord(rawCommand)) {
      fail("invalid-response", "Discord returned an invalid command list.");
    }
    const type = rawCommand.type === undefined ? 1 : rawCommand.type;
    const name = rawCommand.name;
    if (
      typeof type !== "number"
      || !COMMAND_TYPES.has(type)
      || !validRemoteCommandName(type, name)
    ) {
      fail("invalid-response", "Discord returned an invalid command identity.");
    }
    const nextTypeCount = (typeCounts.get(type) ?? 0) + 1;
    if (nextTypeCount > (COMMAND_TYPE_LIMITS.get(type) ?? 0)) {
      fail("invalid-response", "Discord returned too many commands for one type.");
    }
    typeCounts.set(type, nextTypeCount);
    if (
      type !== 1
      && (rawCommand.description !== "" || rawCommand.options !== undefined)
    ) {
      fail("invalid-response", "Discord returned an invalid context command.");
    }
    const key = commandKey(type, name);
    if (commands.has(key)) {
      fail("invalid-response", "Discord returned duplicate command identities.");
    }
    commands.set(
      key,
      rawCommand.type === undefined ? { ...rawCommand, type } : rawCommand,
    );
  }
  return commands;
}

function normalizeRemoteOptions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 25) return [{ invalid: true }];
  return value.map((rawOption) => {
    if (!isRecord(rawOption)) return { invalid: true };
    if (
      rawOption.autocomplete === true
      || rawOption.choices !== undefined
      || rawOption.channel_types !== undefined
      || rawOption.min_value !== undefined
      || rawOption.max_value !== undefined
      || rawOption.min_length !== undefined
      || rawOption.max_length !== undefined
      || rawOption.options !== undefined
    ) return { invalid: true };
    return {
      name: rawOption.name,
      description: rawOption.description,
      type: rawOption.type,
      required: rawOption.required === true,
    };
  });
}

function managedCommandsInSync(diff) {
  return diff.counts.create === 0 && diff.counts.update === 0;
}

function remoteCommandId(command) {
  if (!isRecord(command) || typeof command.id !== "string" || !DISCORD_SNOWFLAKE.test(command.id)) {
    fail("invalid-response", "Discord returned an invalid managed command id.");
  }
  return command.id;
}

function normalizedDesiredOptions(command) {
  return Array.isArray(command.options) ? command.options : [];
}

function normalizedCommandForHash(command) {
  return {
    name: command.name,
    description: command.description,
    type: command.type,
    options: normalizedDesiredOptions(command),
  };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function changedFields(desired, remote) {
  const fields = [];
  if (remote.description !== desired.description) fields.push("description");
  if (
    JSON.stringify(normalizeRemoteOptions(remote.options))
    !== JSON.stringify(normalizedDesiredOptions(desired))
  ) {
    fields.push("options");
  }
  return fields;
}

/**
 * Return a deliberately content-free diff: command names and changed field
 * names only. Provider payloads, descriptions, ids, and credentials are not
 * included in operator output.
 *
 * @param {unknown} desiredValue
 * @param {unknown} remoteValue
 */
export function buildCommandDiff(desiredValue, remoteValue) {
  const desired = validateDesiredCommands(desiredValue);
  const remote = parseRemoteCommands(remoteValue);
  const desiredKeys = new Set(desired.map((command) => commandKey(1, command.name)));
  const create = [];
  const update = [];

  for (const command of desired) {
    const key = commandKey(1, command.name);
    const existing = remote.get(key);
    if (!existing) {
      create.push(displayCommand(1, command.name));
      continue;
    }
    const fields = changedFields(command, existing);
    if (fields.length > 0) {
      update.push({ command: displayCommand(1, command.name), fields });
    }
  }

  const remove = [...remote.entries()]
    .filter(([key]) => !desiredKeys.has(key))
    .map(([, command]) => displayCommand(command.type, command.name))
    .sort();
  const inSync = create.length === 0 && update.length === 0 && remove.length === 0;
  return {
    inSync,
    counts: {
      desired: desired.length,
      remote: remote.size,
      create: create.length,
      update: update.length,
      delete: remove.length,
    },
    changes: { create, update, delete: remove },
  };
}

/**
 * Bind a GET readback to the exact application and guild before treating a
 * content diff as operational evidence. The returned hashes contain no ids,
 * descriptions, or credentials; equal hashes prove the managed provider
 * projection matches the exact source-controlled manifest.
 *
 * @param {{
 *   desiredValue: unknown,
 *   remoteValue: unknown,
 *   applicationId: string,
 *   guildId: string,
 * }} input
 */
export function verifyGuildCommandReadback({
  desiredValue,
  remoteValue,
  applicationId,
  guildId,
}) {
  if (
    !DISCORD_SNOWFLAKE.test(applicationId)
    || !DISCORD_SNOWFLAKE.test(guildId)
  ) {
    fail("invalid-environment", "Discord command readback target is invalid.");
  }
  const desired = validateDesiredCommands(desiredValue);
  const remote = parseRemoteCommands(remoteValue);
  for (const command of remote.values()) {
    if (
      !DISCORD_SNOWFLAKE.test(command.id)
      || command.application_id !== applicationId
      || command.guild_id !== guildId
    ) {
      fail(
        "invalid-response",
        "Discord command readback did not match the configured application and guild.",
      );
    }
  }
  const diff = buildCommandDiff(desired, remoteValue);
  const manifestProjection = desired.map(normalizedCommandForHash);
  const managedReadbackProjection = desired.map((command) => {
    const remoteCommand = remote.get(commandKey(1, command.name));
    return remoteCommand
      ? normalizedCommandForHash({
          name: remoteCommand.name,
          description: remoteCommand.description,
          type: remoteCommand.type,
          options: normalizeRemoteOptions(remoteCommand.options),
        })
      : null;
  });
  return {
    ...diff,
    providerReadbackVerified: true,
    guildPermissionVisibility: "unchecked",
    liveInvocationVerified: false,
    manifestSha256: sha256Json(manifestProjection),
    managedReadbackSha256: sha256Json(managedReadbackProjection),
  };
}

/** @param {Record<string, string | undefined>} environment */
export function validateDiscordEnvironment(environment) {
  const applicationId = environment.OPENZAPS_DISCORD_APPLICATION_ID;
  const guildId = environment.OPENZAPS_DISCORD_GUILD_ID;
  const token = environment.DISCORD_BOT_TOKEN;
  if (!applicationId || !DISCORD_SNOWFLAKE.test(applicationId)) {
    fail(
      "invalid-environment",
      "OPENZAPS_DISCORD_APPLICATION_ID must be a valid Discord snowflake.",
    );
  }
  if (!guildId || !DISCORD_SNOWFLAKE.test(guildId)) {
    fail(
      "invalid-environment",
      "OPENZAPS_DISCORD_GUILD_ID must be a valid Discord snowflake.",
    );
  }
  if (!token || token.trim() !== token || !DISCORD_BOT_TOKEN.test(token)) {
    fail(
      "invalid-environment",
      "DISCORD_BOT_TOKEN must be a valid non-empty bot token in the environment.",
    );
  }
  return { applicationId, guildId, token };
}

/** @param {string[]} args */
export function parseCliArguments(args) {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  fail(
    "invalid-arguments",
    "Usage: npm run discord:commands or npm run discord:commands:apply.",
  );
}

async function readBoundedJson(response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    fail("invalid-response", "Discord returned a non-JSON response.");
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d{1,9}$/u.test(rawLength) || Number(rawLength) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      fail("invalid-response", "Discord returned an oversized response.");
    }
  }
  if (!response.body) {
    fail("invalid-response", "Discord returned an empty response.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        fail("invalid-response", "Discord returned an invalid response stream.");
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("invalid-response", "Discord returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-response", "Discord returned invalid JSON.");
  }
}

async function discordJsonRequest({
  fetchImpl,
  url,
  token,
  method,
  body,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bot ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      fail("network-error", "Discord API request failed before a response was received.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      fail("provider-error", `Discord API request failed (${response.status}).`);
    }
    try {
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof DiscordCommandReconciliationError) throw error;
      fail("network-error", "Discord API response could not be read safely.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read current guild commands by default. Explicit apply mode creates or
 * patches only the three OpenZaps-managed command names. It never bulk
 * overwrites the guild command set and never deletes an unrelated command.
 */
export async function reconcileDiscordCommands({
  environment = process.env,
  apply = false,
  desiredCommands,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof apply !== "boolean") {
    fail("invalid-arguments", "Discord command apply mode must be explicit.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("invalid-arguments", "Discord command request timeout is invalid.");
  }
  const { applicationId, guildId, token } = validateDiscordEnvironment(environment);
  const desired = desiredCommands === undefined
    ? await loadDesiredCommands()
    : validateDesiredCommands(desiredCommands);
  const endpoint =
    `${DISCORD_API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;
  const current = await discordJsonRequest({
    fetchImpl,
    url: endpoint,
    token,
    method: "GET",
    timeoutMs,
  });
  const diff = verifyGuildCommandReadback({
    desiredValue: desired,
    remoteValue: current,
    applicationId,
    guildId,
  });
  if (!apply || managedCommandsInSync(diff)) {
    return {
      schemaVersion: 1,
      mode: apply ? "apply" : "dry-run",
      scope: "guild",
      inSync: diff.inSync,
      managedCommandsInSync: managedCommandsInSync(diff),
      applied: false,
      verified: true,
      providerReadbackVerified: diff.providerReadbackVerified,
      guildPermissionVisibility: diff.guildPermissionVisibility,
      liveInvocationVerified: diff.liveInvocationVerified,
      manifestSha256: diff.manifestSha256,
      managedReadbackSha256: diff.managedReadbackSha256,
      counts: diff.counts,
      changes: diff.changes,
    };
  }

  const currentByKey = parseRemoteCommands(current);
  for (const command of desired) {
    const existing = currentByKey.get(commandKey(1, command.name));
    const changed = existing ? changedFields(command, existing) : ["missing"];
    if (changed.length === 0) continue;
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      fail("invalid-manifest", "Discord command manifest is too large to apply.");
    }
    await discordJsonRequest({
      fetchImpl,
      url: existing ? `${endpoint}/${remoteCommandId(existing)}` : endpoint,
      token,
      method: existing ? "PATCH" : "POST",
      body,
      timeoutMs,
    });
  }
  const verifiedCommands = await discordJsonRequest({
    fetchImpl,
    url: endpoint,
    token,
    method: "GET",
    timeoutMs,
  });
  const verification = verifyGuildCommandReadback({
    desiredValue: desired,
    remoteValue: verifiedCommands,
    applicationId,
    guildId,
  });
  if (!managedCommandsInSync(verification)) {
    fail("verification-error", "Discord command reconciliation did not converge.");
  }
  return {
    schemaVersion: 1,
    mode: "apply",
    scope: "guild",
    inSync: verification.inSync,
    managedCommandsInSync: true,
    applied: true,
    verified: true,
    providerReadbackVerified: verification.providerReadbackVerified,
    guildPermissionVisibility: verification.guildPermissionVisibility,
    liveInvocationVerified: verification.liveInvocationVerified,
    manifestSha256: verification.manifestSha256,
    managedReadbackSha256: verification.managedReadbackSha256,
    counts: diff.counts,
    changes: diff.changes,
  };
}

/**
 * Production-safe read boundary for operator observability. Unlike the CLI
 * reconciler, this wrapper exposes no apply flag, so callers cannot make a
 * Discord command mutation reachable from request input.
 */
export async function readDiscordGuildCommands({
  environment = process.env,
  desiredCommands,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return reconcileDiscordCommands({
    environment,
    apply: false,
    desiredCommands,
    fetchImpl,
    timeoutMs,
  });
}

async function main() {
  try {
    const { apply } = parseCliArguments(process.argv.slice(2));
    const result = await reconcileDiscordCommands({ apply });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const safeError = error instanceof DiscordCommandReconciliationError
      ? error
      : new DiscordCommandReconciliationError(
        "unexpected-error",
        "Discord command reconciliation failed unexpectedly.",
      );
    process.stderr.write(`${JSON.stringify({
      ok: false,
      schemaVersion: 1,
      code: safeError.code,
      message: safeError.message,
    })}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entrypoint) {
  await main();
}
