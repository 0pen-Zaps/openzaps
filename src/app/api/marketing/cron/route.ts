import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { readMarketingConfig } from "@/lib/marketing";
import { claimMarketingScheduleSlot } from "@/lib/marketing/ledger-server";
import {
  DEPLOYED_MARKETING_CHANNELS,
  type MarketingDraftRequest,
} from "@/workflows/marketing-agent/contracts";
import { openZapsMarketingWorkflow } from "@/workflows/marketing-agent";

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

function scheduledChannels(): MarketingDraftRequest["channels"] {
  const requested = (process.env.OPENZAPS_MARKETING_SCHEDULE_CHANNELS ?? "x,discord")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is (typeof DEPLOYED_MARKETING_CHANNELS)[number] =>
      DEPLOYED_MARKETING_CHANNELS.includes(value as (typeof DEPLOYED_MARKETING_CHANNELS)[number]),
    );
  return [...new Set(requested)].slice(0, 3) as MarketingDraftRequest["channels"];
}

export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  const config = readMarketingConfig();
  if (
    process.env.OPENZAPS_MARKETING_SCHEDULE_ENABLED !== "true" ||
    !config.readiness.canDraft
  ) {
    return NextResponse.json(
      {
        skipped: true,
        reason:
          process.env.OPENZAPS_MARKETING_SCHEDULE_ENABLED !== "true"
            ? "Scheduled drafting is disabled."
            : "Marketing drafting is not ready.",
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

  const channels = scheduledChannels();
  if (channels.length === 0) {
    return NextResponse.json(
      { skipped: true, reason: "No reviewed scheduled channel is configured." },
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
    const run = await start(openZapsMarketingWorkflow, [
      {
        kind: "product_update",
        brief:
          "Draft today's most useful evidence-backed OpenZaps update. Prefer education or a meaningful verified change over vanity metrics. If the sources show no material change, write an evergreen explanation of bounded agent authority. Do not imply an audit, partnership, return, or launch that the evidence does not prove.",
        channels,
        sourceUrls: [],
      },
    ]);
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
