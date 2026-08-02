import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseReviewOnlyCampaignSnapshot,
  ReviewOnlyCampaignPanel,
  reviewOnlyCampaignCanCopy,
  reviewOnlyCampaignCopyRequestIsCurrent,
  reviewOnlyCampaignServerNow,
  writeReviewOnlyCampaignClipboard,
  type OperatorReviewOnlyCampaign,
} from "./MarketingOperator";

const X_CAMPAIGN: OperatorReviewOnlyCampaign = {
  id: "fee-rewards-campaign-v1",
  channel: "x",
  body: "Exact reviewed X draft.\n\nPre-audit software. Verify before use.",
  contentHash:
    "69c67b003586adec1309b417161b967d4ff3003b26a208bfec29ea705082c749",
  notBefore: "2026-08-03T00:23:00.000Z",
  notAfter: "2026-08-10T00:23:00.000Z",
  canonicalSourceUrls: [
    "https://www.0xzaps.com/rewards",
    "https://www.0xzaps.com/api/protocol/rewards",
  ],
};

const DISCORD_CAMPAIGN: OperatorReviewOnlyCampaign = {
  ...X_CAMPAIGN,
  channel: "discord",
  body: "Exact reviewed Discord draft.\n\nPre-audit software. Verify before use.",
  contentHash:
    "1c8588ed3256b2802a2dc2510f77df1d7a48ee59ccaf382ff22508008a22abf3",
};

function responseBody(
  campaigns: OperatorReviewOnlyCampaign[] = [X_CAMPAIGN, DISCORD_CAMPAIGN],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    evaluatedAt: "2026-08-03T00:23:00.000Z",
    campaigns,
    ownerReviewRequired: true,
    automaticQueueEligible: false,
    workflowsStarted: false,
    providerWritesAttempted: false,
    writesPerformed: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("review-only campaign operator lane", () => {
  it("accepts the exact active source bundle", () => {
    const parsed = parseReviewOnlyCampaignSnapshot(responseBody());

    expect(parsed).toEqual({
      evaluatedAt: "2026-08-03T00:23:00.000Z",
      campaigns: [X_CAMPAIGN, DISCORD_CAMPAIGN],
    });
  });

  it("fails the whole bundle closed for contradictory gates or unsafe artifacts", () => {
    expect(parseReviewOnlyCampaignSnapshot({
      ...responseBody(),
      providerWritesAttempted: true,
    })).toBeNull();
    expect(parseReviewOnlyCampaignSnapshot({
      ...responseBody(),
      schemaVersion: 2,
    })).toBeNull();
    const withoutVersion = responseBody();
    delete withoutVersion.schemaVersion;
    expect(parseReviewOnlyCampaignSnapshot(withoutVersion)).toBeNull();
    expect(parseReviewOnlyCampaignSnapshot(responseBody([
      X_CAMPAIGN,
      { ...X_CAMPAIGN },
    ]))).toBeNull();
    expect(parseReviewOnlyCampaignSnapshot(responseBody([{
      ...X_CAMPAIGN,
      canonicalSourceUrls: ["https://user:pass@www.0xzaps.com/rewards"],
    }]))).toBeNull();
    expect(parseReviewOnlyCampaignSnapshot(responseBody([{
      ...X_CAMPAIGN,
      body: "x".repeat(281),
    }]))).toBeNull();
    expect(parseReviewOnlyCampaignSnapshot({
      ...responseBody(),
      evaluatedAt: X_CAMPAIGN.notAfter,
    })).toBeNull();
  });

  it("uses an inclusive start and exclusive end for local copy", () => {
    expect(reviewOnlyCampaignCanCopy(
      X_CAMPAIGN,
      X_CAMPAIGN.notBefore,
    )).toBe(true);
    expect(reviewOnlyCampaignCanCopy(
      X_CAMPAIGN,
      "2026-08-09T23:59:59.999Z",
    )).toBe(true);
    expect(reviewOnlyCampaignCanCopy(
      X_CAMPAIGN,
      X_CAMPAIGN.notAfter,
    )).toBe(false);
  });

  it("advances from the server receipt using monotonic time, not the device clock", () => {
    vi.useFakeTimers();
    const clock = {
      serverAtReceiptMs: Date.parse("2026-08-03T00:23:00.500Z"),
      monotonicAtReceiptMs: 1_000,
    };

    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    expect(reviewOnlyCampaignServerNow(clock, 4_500)).toBe(
      "2026-08-03T00:23:04.000Z",
    );
    vi.setSystemTime(new Date("2001-01-01T00:00:00.000Z"));
    expect(reviewOnlyCampaignServerNow(clock, 4_500)).toBe(
      "2026-08-03T00:23:04.000Z",
    );
    expect(reviewOnlyCampaignServerNow(clock, 999)).toBeNull();
  });

  it("rejects stale or superseded clipboard completions", () => {
    const snapshot = {
      evaluatedAt: "2026-08-03T00:23:00.000Z",
      campaigns: [X_CAMPAIGN, DISCORD_CAMPAIGN],
    };
    const current = {
      expectedCopyGeneration: 2,
      currentCopyGeneration: 2,
      expectedRequestGeneration: 4,
      currentRequestGeneration: 4,
      campaign: DISCORD_CAMPAIGN,
      snapshot,
      serverNow: "2026-08-03T00:23:01.000Z",
    };

    expect(reviewOnlyCampaignCopyRequestIsCurrent(current)).toBe(true);
    expect(reviewOnlyCampaignCopyRequestIsCurrent({
      ...current,
      expectedCopyGeneration: 1,
    })).toBe(false);
    expect(reviewOnlyCampaignCopyRequestIsCurrent({
      ...current,
      expectedRequestGeneration: 3,
    })).toBe(false);
    expect(reviewOnlyCampaignCopyRequestIsCurrent({
      ...current,
      serverNow: DISCORD_CAMPAIGN.notAfter,
    })).toBe(false);
  });

  it("copies only the byte-exact body and fails closed without clipboard access", async () => {
    const writeText = vi.fn(async () => undefined);

    await writeReviewOnlyCampaignClipboard(
      X_CAMPAIGN.body,
      { writeText },
    );

    expect(writeText).toHaveBeenCalledWith(X_CAMPAIGN.body);
    expect(writeText).toHaveBeenCalledTimes(1);
    await expect(
      writeReviewOnlyCampaignClipboard(X_CAMPAIGN.body, undefined),
    ).rejects.toThrow("Clipboard unavailable");
  });

  it("renders a draft-only local-copy surface without an approval or publish control", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:23:01.000Z"));

    const html = renderToStaticMarkup(createElement(ReviewOnlyCampaignPanel, {
      snapshot: {
        evaluatedAt: "2026-08-03T00:23:00.000Z",
        campaigns: [X_CAMPAIGN],
      },
      state: "ready",
      error: "",
      serverNow: "2026-08-03T00:23:01.000Z",
      copiedKey: "",
      copyingKey: "",
      onRefresh: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(html).toContain("DRAFT ONLY — OWNER REVIEW REQUIRED");
    expect(html).toContain("Copy exact draft");
    expect(html).toContain(X_CAMPAIGN.body);
    expect(html).toContain("Canonical campaign payload SHA-256");
    expect(html).toContain(X_CAMPAIGN.contentHash);
    expect(html).toContain("https://www.0xzaps.com/api/protocol/rewards");
    expect(html).toContain("end exclusive");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(?:Approve|Publish|Start workflow)/iu);
  });

  it("disables every copy control while one clipboard request is pending", () => {
    const pendingKey = `${X_CAMPAIGN.id}:${X_CAMPAIGN.channel}:${X_CAMPAIGN.contentHash}`;
    const html = renderToStaticMarkup(createElement(ReviewOnlyCampaignPanel, {
      snapshot: {
        evaluatedAt: "2026-08-03T00:23:00.000Z",
        campaigns: [X_CAMPAIGN, DISCORD_CAMPAIGN],
      },
      state: "ready",
      error: "",
      serverNow: "2026-08-03T00:23:01.000Z",
      copiedKey: "",
      copyingKey: pendingKey,
      onRefresh: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(html).toContain("Copying…");
    expect((html.match(/<button[^>]*disabled=""/gu) ?? [])).toHaveLength(2);
  });
});
