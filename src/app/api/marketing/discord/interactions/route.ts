import { NextResponse } from "next/server";

import {
  verifyDiscordInteractionSignature,
} from "@/lib/marketing/channels";
import { isSupportedDiscordCommandName } from "@/lib/marketing/discord-commands";
import { answerOpenZapsFaq } from "@/lib/marketing/discord-faq";
import { BoundedTextBodyError, readBoundedTextBody } from "@/lib/request-body";

export const dynamic = "force-dynamic";
const MAX_INTERACTION_REQUEST_BYTES = 1_000_000;
const DISCORD_ID = /^\d{1,30}$/u;

interface DiscordOption {
  name?: unknown;
  value?: unknown;
  options?: unknown;
}

interface DiscordInteraction {
  type?: unknown;
  application_id?: unknown;
  guild_id?: unknown;
  data?: {
    name?: unknown;
    options?: unknown;
  };
}

function findStringOption(options: unknown): string {
  if (!Array.isArray(options)) return "";
  for (const item of options) {
    const option = item && typeof item === "object" ? (item as DiscordOption) : null;
    if (!option) continue;
    if (typeof option.value === "string") return option.value;
    const nested = findStringOption(option.options);
    if (nested) return nested;
  }
  return "";
}

function interactionMessage(content: string): NextResponse {
  return NextResponse.json({
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] },
    },
  });
}

function isConfiguredInteractionTarget(
  interaction: DiscordInteraction,
): boolean {
  const applicationId = process.env.OPENZAPS_DISCORD_APPLICATION_ID;
  const guildId = process.env.OPENZAPS_DISCORD_GUILD_ID;
  return Boolean(
    applicationId &&
    guildId &&
    DISCORD_ID.test(applicationId) &&
    DISCORD_ID.test(guildId) &&
    interaction.application_id === applicationId &&
    (
      interaction.guild_id === guildId
      || (interaction.type === 1 && interaction.guild_id === undefined)
    ),
  );
}

function forbiddenInteraction(): Response {
  return new Response(null, {
    status: 403,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await readBoundedTextBody(request, MAX_INTERACTION_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedTextBodyError) {
      return NextResponse.json(
        { error: "Interaction request too large." },
        { status: 413, headers: { "cache-control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Invalid interaction body." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const valid = await verifyDiscordInteractionSignature({
    rawBody,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
  });
  if (!valid) {
    return NextResponse.json({ error: "Invalid request signature." }, { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return NextResponse.json({ error: "Invalid interaction body." }, { status: 400 });
  }
  if (!isConfiguredInteractionTarget(interaction)) {
    return forbiddenInteraction();
  }
  if (interaction.type === 1) return NextResponse.json({ type: 1 });
  if (interaction.type !== 2) {
    return interactionMessage(
      "That interaction is not enabled. Use /ask with a question about OpenZaps.",
    );
  }

  const command =
    typeof interaction.data?.name === "string"
      ? interaction.data.name.toLowerCase()
      : "";
  if (!isSupportedDiscordCommandName(command)) {
    return interactionMessage(
      "This bot only responds to /ask, /openzaps, and /status.",
    );
  }
  const question =
    command === "status"
      ? "Is OpenZaps audited and production ready?"
      : findStringOption(interaction.data?.options) || "What is OpenZaps?";
  return interactionMessage(answerOpenZapsFaq(question).content);
}
