import "server-only";

import { createHash, createHmac } from "node:crypto";
import { after } from "next/server";

import { isMarketingLedgerSupabaseUrl } from "@/lib/marketing/config";
import { DISCORD_COMMAND_MANIFEST_SHA256 } from "@/lib/marketing/discord-command-manifest";
import {
  DISCORD_COMMAND_MANIFEST,
  isSupportedDiscordCommandName,
  type DiscordCommandName,
} from "@/lib/marketing/discord-commands";
import { readBoundedJsonBody } from "@/lib/request-body";

const RECORD_RPC = "record_marketing_discord_command_invocation_receipt";
const READBACK_RPC = "get_marketing_discord_command_invocation_readback";
const TARGET_BINDING_DOMAIN = "openzaps:discord-command-invocation-target:v2";
const FAILURE_LOG =
  "OpenZaps Discord command invocation receipt could not be recorded.";
const DISCORD_ID = /^\d{1,30}$/u;
const DISCORD_PUBLIC_KEY = /^[0-9a-f]{64}$/iu;
const MAX_RPC_RESPONSE_BYTES = 16 * 1_024;
const RPC_TIMEOUT_MS = 5_000;

type Environment = Readonly<Record<string, string | undefined>>;

interface ReceiptConfiguration {
  restUrl: string;
  serviceRoleKey: string;
  targetBindingHmac: string;
}

export interface DiscordCommandInvocationReadbackEntry {
  command: DiscordCommandName;
  observed: boolean;
  firstVerifiedAt: string | null;
}

export interface DiscordCommandInvocationReadback {
  schemaVersion: 1;
  status: "current_manifest_seen" | "not_observed";
  scope: "privacy_safe_configured_target_receipts";
  manifestSha256: string;
  commands: DiscordCommandInvocationReadbackEntry[];
  anyVerifiedInvocationObserved: boolean;
  allCommandsObserved: boolean;
  uniqueInvocationsCounted: false;
  responseDeliveryVerified: false;
  writesPerformed: false;
}

export type DiscordCommandInvocationReceiptErrorCode =
  | "not_configured"
  | "invalid_input"
  | "network_error"
  | "rpc_error"
  | "invalid_response";

export class DiscordCommandInvocationReceiptError extends Error {
  constructor(
    readonly code: DiscordCommandInvocationReceiptErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscordCommandInvocationReceiptError";
  }
}

function hasSecret(value: string | undefined): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\r\n]/u.test(value);
}

function targetBindingHmac(
  serviceRoleKey: string,
  applicationId: string,
  guildId: string,
  publicKey: string,
): string {
  const signingKeyFingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "hex"))
    .digest("hex");
  return createHmac("sha256", serviceRoleKey)
    .update(
      `${TARGET_BINDING_DOMAIN}\0application:${applicationId}\0guild:${guildId}\0signing-key-sha256:${signingKeyFingerprint}`,
      "utf8",
    )
    .digest("hex");
}

function configuration(env: Environment): ReceiptConfiguration | null {
  if (env.OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED !== "true") return null;
  if (!hasSecret(env.SUPABASE_SERVICE_ROLE_KEY)) return null;
  const applicationId = env.OPENZAPS_DISCORD_APPLICATION_ID;
  const guildId = env.OPENZAPS_DISCORD_GUILD_ID;
  const publicKey = env.DISCORD_APPLICATION_PUBLIC_KEY;
  if (
    !DISCORD_ID.test(applicationId ?? "")
    || !DISCORD_ID.test(guildId ?? "")
    || !DISCORD_PUBLIC_KEY.test(publicKey ?? "")
  ) {
    return null;
  }
  const rawUrl = env.SUPABASE_URL;
  if (
    !rawUrl
    || !isMarketingLedgerSupabaseUrl(
      rawUrl,
      env.OPENZAPS_MARKETING_SUPABASE_PROJECT_REF,
      env.NODE_ENV !== "production",
    )
  ) return null;

  try {
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY.trim();
    const base = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
    return {
      restUrl: new URL("rest/v1/", base).toString(),
      serviceRoleKey,
      targetBindingHmac: targetBindingHmac(
        serviceRoleKey,
        applicationId as string,
        guildId as string,
        publicKey as string,
      ),
    };
  } catch {
    return null;
  }
}

function requireConfiguration(env: Environment): ReceiptConfiguration {
  const configured = configuration(env);
  if (!configured) {
    throw new DiscordCommandInvocationReceiptError(
      "not_configured",
      "The durable Discord command invocation receipt is not configured.",
    );
  }
  return configured;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactRow(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const row = record(value);
  if (
    !row
    || Object.keys(row).length !== keys.length
    || keys.some((key) => !Object.hasOwn(row, key))
  ) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid response.",
    );
  }
  return row;
}

function exactText(
  row: Record<string, unknown>,
  key: string,
  expected: string,
): string {
  const value = row[key];
  if (value !== expected) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned mismatched evidence.",
    );
  }
  return value;
}

function minuteRoundedTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid timestamp.",
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 60_000 !== 0) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid timestamp.",
    );
  }
  return new Date(milliseconds).toISOString();
}

async function callRpc(
  rpc: string,
  body: Readonly<Record<string, string>>,
  configured: ReceiptConfiguration,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(`rpc/${rpc}`, configured.restUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: configured.serviceRoleKey,
        authorization: `Bearer ${configured.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    throw new DiscordCommandInvocationReceiptError(
      "network_error",
      "The durable Discord command invocation receipt could not be reached.",
    );
  }
  if (!response.ok) {
    throw new DiscordCommandInvocationReceiptError(
      "rpc_error",
      `The durable Discord command invocation receipt rejected the request (${response.status}).`,
      response.status,
    );
  }
  try {
    return await readBoundedJsonBody(response, MAX_RPC_RESPONSE_BYTES);
  } catch {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid response.",
    );
  }
}

async function recordInvocationReceipt(
  command: DiscordCommandName,
  configured: ReceiptConfiguration,
): Promise<void> {
  const raw = await callRpc(RECORD_RPC, {
    p_target_binding_hmac: configured.targetBindingHmac,
    p_command_name: command,
    p_manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
  }, configured);
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid response.",
    );
  }
  const row = exactRow(raw[0], [
    "result_code",
    "target_binding_hmac",
    "command_name",
    "manifest_sha256",
    "first_verified_at",
  ]);
  if (row.result_code !== "recorded" && row.result_code !== "already_recorded") {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation receipt returned an invalid result.",
    );
  }
  exactText(
    row,
    "target_binding_hmac",
    configured.targetBindingHmac,
  );
  exactText(row, "command_name", command);
  exactText(row, "manifest_sha256", DISCORD_COMMAND_MANIFEST_SHA256);
  minuteRoundedTimestamp(row.first_verified_at);
}

function retryable(error: unknown): boolean {
  return error instanceof DiscordCommandInvocationReceiptError
    && (
      error.code === "network_error"
      || (
        error.code === "rpc_error"
        && typeof error.status === "number"
        && error.status >= 500
        && error.status <= 599
      )
    );
}

async function recordWithOneRetry(
  command: DiscordCommandName,
  configured: ReceiptConfiguration,
): Promise<void> {
  try {
    await recordInvocationReceipt(command, configured);
  } catch (error) {
    if (!retryable(error)) throw error;
    await recordInvocationReceipt(command, configured);
  }
}

/**
 * Schedule an append-once receipt after a verified interaction response. Any
 * storage/configuration failure is reduced to one fixed, non-sensitive log.
 */
export function scheduleDiscordCommandInvocationReceipt(
  command: DiscordCommandName,
): void {
  try {
    if (!isSupportedDiscordCommandName(command)) {
      throw new DiscordCommandInvocationReceiptError(
        "invalid_input",
        "The Discord command invocation receipt command is invalid.",
      );
    }
    const configured = requireConfiguration(process.env);
    after(async () => {
      try {
        await recordWithOneRetry(command, configured);
      } catch {
        console.error(FAILURE_LOG);
      }
    });
  } catch {
    console.error(FAILURE_LOG);
  }
}

/** Read privacy-safe first-observation receipts for the exact current target. */
export async function getDiscordCommandInvocationReadback(): Promise<DiscordCommandInvocationReadback> {
  const configured = requireConfiguration(process.env);
  const raw = await callRpc(READBACK_RPC, {
    p_target_binding_hmac: configured.targetBindingHmac,
    p_manifest_sha256: DISCORD_COMMAND_MANIFEST_SHA256,
  }, configured);
  if (!Array.isArray(raw) || raw.length !== DISCORD_COMMAND_MANIFEST.length) {
    throw new DiscordCommandInvocationReceiptError(
      "invalid_response",
      "The Discord command invocation readback returned an invalid response.",
    );
  }

  const commands = DISCORD_COMMAND_MANIFEST.map((manifestCommand, index) => {
    const row = exactRow(raw[index], [
      "target_binding_hmac",
      "manifest_sha256",
      "command_name",
      "observed",
      "first_verified_at",
    ]);
    exactText(
      row,
      "target_binding_hmac",
      configured.targetBindingHmac,
    );
    exactText(row, "manifest_sha256", DISCORD_COMMAND_MANIFEST_SHA256);
    exactText(row, "command_name", manifestCommand.name);
    if (typeof row.observed !== "boolean") {
      throw new DiscordCommandInvocationReceiptError(
        "invalid_response",
        "The Discord command invocation readback returned an invalid response.",
      );
    }
    const firstVerifiedAt = row.observed
      ? minuteRoundedTimestamp(row.first_verified_at)
      : null;
    if (!row.observed && row.first_verified_at !== null) {
      throw new DiscordCommandInvocationReceiptError(
        "invalid_response",
        "The Discord command invocation readback returned mismatched evidence.",
      );
    }
    return {
      command: manifestCommand.name,
      observed: row.observed,
      firstVerifiedAt,
    };
  });
  const anyVerifiedInvocationObserved = commands.some((entry) => entry.observed);
  const allCommandsObserved = commands.every((entry) => entry.observed);

  return {
    schemaVersion: 1,
    status: anyVerifiedInvocationObserved
      ? "current_manifest_seen"
      : "not_observed",
    scope: "privacy_safe_configured_target_receipts",
    manifestSha256: DISCORD_COMMAND_MANIFEST_SHA256,
    commands,
    anyVerifiedInvocationObserved,
    allCommandsObserved,
    uniqueInvocationsCounted: false,
    responseDeliveryVerified: false,
    writesPerformed: false,
  };
}
