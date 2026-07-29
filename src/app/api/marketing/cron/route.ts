import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  readMarketingConfig,
  SCHEDULED_MARKETING_CHANNELS,
  type MarketingConfig,
} from "@/lib/marketing";
import { claimMarketingScheduleSlot } from "@/lib/marketing/ledger-server";
import {
  type MarketingScheduledRequest,
} from "@/workflows/marketing-agent/contracts";
import { openZapsScheduledMarketingWorkflow } from "@/workflows/marketing-agent";

export const dynamic = "force-dynamic";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isCronAuthorized(request: Pick<Request, "headers">): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer[ \t]+([^\s,]+)$/iu);
  const supplied = match?.[1] ?? "";
  return (
    expected.trim().length > 0 &&
    supplied.length > 0 &&
    timingSafeEqual(digest(expected), digest(supplied))
  );
}

function scheduledChannels(
  config: MarketingConfig,
): MarketingScheduledRequest["channels"] {
  const requested = (process.env.OPENZAPS_MARKETING_SCHEDULE_CHANNELS ?? "x,discord")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is (typeof SCHEDULED_MARKETING_CHANNELS)[number] =>
      SCHEDULED_MARKETING_CHANNELS.includes(
        value as (typeof SCHEDULED_MARKETING_CHANNELS)[number],
      ),
    );
  return [...new Set(requested)].filter((channel) =>
    channel === "x"
      ? config.readiness.channels.x
      : config.readiness.channels.discordBroadcast,
  ) as MarketingScheduledRequest["channels"];
}

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  const config = readMarketingConfig();
  if (process.env.OPENZAPS_MARKETING_SCHEDULE_ENABLED !== "true") {
    return NextResponse.json(
      {
        skipped: true,
        reason: "Scheduled drafting is disabled.",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  if (!config.readiness.durableLedgerConfigured) {
    return NextResponse.json(
      { error: "Durable scheduled-marketing admission is not configured." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (!config.readiness.canDraft) {
    return NextResponse.json(
      {
        skipped: true,
        reason: "Marketing drafting is not ready.",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  if (!config.autoPublish) {
    return NextResponse.json(
      {
        skipped: true,
        reason: "Bounded automatic publishing is not ready.",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const channels = scheduledChannels(config);
  if (channels.length === 0) {
    return NextResponse.json(
      {
        skipped: true,
        reason: "No requested scheduled channel has a ready publish provider.",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  let slot;
  try {
    slot = await claimMarketingScheduleSlot();
  } catch {
    return NextResponse.json(
      {
        error:
          "Scheduled marketing admission could not be confirmed; no workflow was started.",
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (slot.result === "outside_schedule") {
    return NextResponse.json(
      {
        skipped: true,
        status: "outside_schedule",
        scheduleKey: slot.scheduleKey,
        slotDay: slot.day,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  if (slot.result === "already_claimed") {
    return NextResponse.json(
      {
        started: false,
        status: "already_claimed",
        scheduleKey: slot.scheduleKey,
        slotDay: slot.day,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const run = await start(openZapsScheduledMarketingWorkflow, [{ channels }]);
    return NextResponse.json(
      {
        runId: run.runId,
        status: "queued",
        scheduleKey: slot.scheduleKey,
        slotDay: slot.day,
      },
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "The schedule slot was claimed, but workflow start could not be confirmed. No automatic retry will start another run.",
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
