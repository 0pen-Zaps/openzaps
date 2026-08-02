import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import { verifyDiscordPublishDestination } from "@/lib/marketing/channels/discord";
import { ChannelAdapterError } from "@/lib/marketing/channels/shared";
import { getDiscordCommandInvocationReadback } from "@/lib/marketing/discord-command-invocation-receipt-server";
import { verifyDiscordGuildCommands } from "@/lib/marketing/discord-command-readback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CommandInvocationManifestConsistency =
  | "matched"
  | "not_checked"
  | "mismatch";

function unavailableInvocationReadback() {
  return {
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
  } as const;
}

function manifestConsistency<
  CommandReadback extends Readonly<{
    status: string;
    manifestSha256?: string;
  }>,
  InvocationReadback extends Readonly<{
    status: string;
    manifestSha256: string | null;
  }>,
>(
  commandReadback: CommandReadback,
  invocationReadback: InvocationReadback,
): CommandInvocationManifestConsistency {
  if (
    invocationReadback.status === "unavailable"
    || typeof commandReadback.manifestSha256 !== "string"
    || typeof invocationReadback.manifestSha256 !== "string"
  ) return "not_checked";
  return commandReadback.manifestSha256 === invocationReadback.manifestSha256
    ? "matched"
    : "mismatch";
}

function boundedRetryAfter(error: unknown): string | null {
  if (!(error instanceof ChannelAdapterError)) return null;
  const retryAfterMs = error.details.retryAfterMs;
  if (
    typeof retryAfterMs !== "number"
    || !Number.isSafeInteger(retryAfterMs)
    || retryAfterMs <= 0
  ) {
    return null;
  }
  return String(Math.min(86_400, Math.ceil(retryAfterMs / 1_000)));
}

export async function GET(request: Request): Promise<Response> {
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  try {
    const destination = await verifyDiscordPublishDestination();
    let commandReadback;
    try {
      commandReadback = await verifyDiscordGuildCommands();
    } catch {
      commandReadback = {
        schemaVersion: 1,
        status: "unavailable",
        scope: "configured_application_guild",
        verified: false,
        providerReadbackVerified: false,
        managedCommandsInSync: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      } as const;
    }
    let invocationReadback;
    try {
      invocationReadback = await getDiscordCommandInvocationReadback();
    } catch {
      invocationReadback = unavailableInvocationReadback();
    }
    const commandInvocationManifestConsistency = manifestConsistency(
      commandReadback,
      invocationReadback,
    );
    if (commandInvocationManifestConsistency === "mismatch") {
      invocationReadback = unavailableInvocationReadback();
    }
    return NextResponse.json(
      {
        service: "OpenZaps Discord destination and command-manifest preflight",
        destination,
        commandReadback,
        invocationReadback,
        commandInvocationManifestConsistency,
        writesPerformed: false,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const headers = new Headers({ "cache-control": "private, no-store" });
    const retryAfter = boundedRetryAfter(error);
    if (retryAfter) headers.set("retry-after", retryAfter);
    return NextResponse.json(
      {
        error: "Discord destination could not be verified.",
        destination: { verified: false },
        commandReadback: "not_checked",
        invocationReadback: "not_checked",
        commandInvocationManifestConsistency: "not_checked",
        writesPerformed: false,
      },
      { status: 503, headers },
    );
  }
}
