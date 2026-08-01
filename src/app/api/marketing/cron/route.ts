import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { isCronAuthorized } from "@/lib/cron-auth";
import {
  readMarketingConfig,
  SCHEDULED_MARKETING_CHANNELS,
  type MarketingConfig,
} from "@/lib/marketing";
import { claimNextReviewedMarketingCampaign } from "@/lib/marketing/ledger-server";
import { openZapsScheduledMarketingWorkflow } from "@/workflows/marketing-agent";

export const dynamic = "force-dynamic";

export { isCronAuthorized } from "@/lib/cron-auth";

function scheduledChannels(
  config: MarketingConfig,
): Array<(typeof SCHEDULED_MARKETING_CHANNELS)[number]> {
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
  ) as Array<(typeof SCHEDULED_MARKETING_CHANNELS)[number]>;
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
    slot = await claimNextReviewedMarketingCampaign(channels);
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
  if (slot.result === "no_pending_campaign") {
    return NextResponse.json(
      {
        started: false,
        status: "no_pending_campaign",
        scheduleKey: slot.scheduleKey,
        slotDay: slot.day,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  if (!slot.campaign) {
    return NextResponse.json(
      {
        error:
          "Scheduled marketing admission returned no reviewed campaign; no workflow was started.",
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const run = await start(openZapsScheduledMarketingWorkflow, [{
      campaignId: slot.campaign.id,
      channel: slot.campaign.channel,
      slotDay: slot.day,
      contentHash: slot.campaign.contentHash,
    }]);
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
          "The campaign was claimed for today, but workflow start could not be confirmed. No same-day retry will start another run; a later weekday may retry before delivery admission.",
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
