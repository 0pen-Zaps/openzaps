import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { campaignClaimMock, startMock, workflowMock } = vi.hoisted(() => ({
  campaignClaimMock: vi.fn(),
  startMock: vi.fn(),
  workflowMock: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  start: startMock,
}));

vi.mock("@/workflows/marketing-agent", () => ({
  openZapsScheduledMarketingWorkflow: workflowMock,
}));

vi.mock("@/lib/marketing/ledger-server", () => ({
  claimNextReviewedMarketingCampaign: campaignClaimMock,
}));

import { GET, isCronAuthorized } from "./route";

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/cron", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-token");
  vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "false");
  vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "true");
  vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "false");
  vi.stubEnv("OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_ENABLED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_CHANNELS", "x,discord");
  vi.stubEnv("OPENZAPS_MARKETING_SUPABASE_PROJECT_REF", "abcdefghijklmnopqrst");
  vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-secret");
  vi.stubEnv(
    "DISCORD_MARKETING_WEBHOOK_URL",
    "https://discord.com/api/webhooks/123/webhook-secret",
  );
  vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
  vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");
  campaignClaimMock.mockResolvedValue({
    result: "claimed",
    scheduleKey: "weekday_product_update",
    day: "2026-07-29",
    claimedAt: "2026-07-29T14:00:00.000Z",
    campaign: {
      id: "virtual-trading-request-zap-v2",
      channel: "discord",
      contentHash:
        "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
    },
  });
  startMock.mockResolvedValue({ runId: "wrun_cron_1" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing cron route", () => {
  it("fails closed for missing configuration and malformed credentials", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isCronAuthorized(request("anything"))).toBe(false);

    vi.stubEnv("CRON_SECRET", "cron-token");
    expect(isCronAuthorized(request())).toBe(false);
    expect(isCronAuthorized(new Request("https://www.0xzaps.com", {
      headers: { authorization: "Basic cron-token" },
    }))).toBe(false);
    expect(isCronAuthorized(request("cron-token"))).toBe(true);
  });

  it("does not start work for an unauthorized request", async () => {
    const response = await GET(request("wrong-token"));

    expect(response.status).toBe(401);
    expect(campaignClaimMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("skips before claiming when scheduling is disabled or no deployed channel is selected", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_ENABLED", "false");
    const disabled = await GET(request("cron-token"));

    vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_ENABLED", "true");
    vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_CHANNELS", "farcaster,github");
    const noChannel = await GET(request("cron-token"));

    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ skipped: true });
    expect(noChannel.status).toBe(200);
    expect(await noChannel.json()).toEqual({
      skipped: true,
      reason: "No requested scheduled channel has a ready publish provider.",
    });
    expect(campaignClaimMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("normalizes channels and starts only ready scheduled providers", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_SCHEDULE_CHANNELS", "discord,X,discord");

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "wrun_cron_1",
      status: "queued",
      scheduleKey: "weekday_product_update",
      slotDay: "2026-07-29",
    });
    expect(campaignClaimMock).toHaveBeenCalledWith(["discord"]);
    expect(startMock).toHaveBeenCalledOnce();
    expect(campaignClaimMock.mock.invocationCallOrder[0]).toBeLessThan(
      startMock.mock.invocationCallOrder[0],
    );
    expect(startMock.mock.calls[0]?.[0]).toBe(workflowMock);
    expect(startMock.mock.calls[0]?.[1]?.[0]).toEqual({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-29",
      contentHash:
        "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
    });
  });

  it("includes X only after its label, identity, and user credentials are ready", async () => {
    vi.stubEnv("X_USER_ACCESS_TOKEN", "x-user-token");
    vi.stubEnv("OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED", "true");
    vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
    vi.stubEnv("X_EXPECTED_USERNAME", "0xzaps");

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(202);
    expect(campaignClaimMock).toHaveBeenCalledWith(["x", "discord"]);
    expect(startMock.mock.calls[0]?.[1]?.[0]).toEqual({
      campaignId: "virtual-trading-request-zap-v2",
      channel: "discord",
      slotDay: "2026-07-29",
      contentHash:
        "d87798d6ff0ba39a29c5b9da58397162cb43cd4908c5b604493e8fe98a0604f5",
    });
  });

  it("does not claim a slot while bounded auto-publish is disabled", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "false");

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      skipped: true,
      reason: "Bounded automatic publishing is not ready.",
    });
    expect(campaignClaimMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("returns a truthful non-start result for a duplicate or weekend invocation", async () => {
    campaignClaimMock.mockResolvedValueOnce({
      result: "already_claimed",
      scheduleKey: "weekday_product_update",
      day: "2026-07-29",
      claimedAt: "2026-07-29T14:00:00.000Z",
    });
    const duplicate = await GET(request("cron-token"));

    campaignClaimMock.mockResolvedValueOnce({
      result: "outside_schedule",
      scheduleKey: "weekday_product_update",
      day: "2026-08-01",
      claimedAt: null,
    });
    const weekend = await GET(request("cron-token"));

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({
      started: false,
      status: "already_claimed",
      scheduleKey: "weekday_product_update",
      slotDay: "2026-07-29",
    });
    expect(weekend.status).toBe(200);
    expect(await weekend.json()).toEqual({
      skipped: true,
      status: "outside_schedule",
      scheduleKey: "weekday_product_update",
      slotDay: "2026-08-01",
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("returns no_pending_campaign without starting a workflow", async () => {
    campaignClaimMock.mockResolvedValueOnce({
      result: "no_pending_campaign",
      scheduleKey: "weekday_product_update",
      day: "2026-07-29",
      claimedAt: null,
      campaign: null,
    });

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      started: false,
      status: "no_pending_campaign",
      scheduleKey: "weekday_product_update",
      slotDay: "2026-07-29",
    });
    expect(campaignClaimMock).toHaveBeenCalledOnce();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("fails closed before claiming when the durable ledger is not configured", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED", "false");

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Durable scheduled-marketing admission is not configured.",
    });
    expect(campaignClaimMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes ledger admission failures", async () => {
    campaignClaimMock.mockRejectedValue(
      new Error("database credential should-never-leak"),
    );

    const response = await GET(request("cron-token"));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toBe(
      '{"error":"Scheduled marketing admission could not be confirmed; no workflow was started."}',
    );
    expect(raw).not.toContain("should-never-leak");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("sanitizes scheduled workflow start failures after retaining the claimed slot", async () => {
    startMock.mockRejectedValue(new Error("backend credential should-never-leak"));

    const response = await GET(request("cron-token"));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toBe(
      '{"error":"The campaign was claimed for today, but workflow start could not be confirmed. No same-day retry will start another run; a later weekday may retry before delivery admission."}',
    );
    expect(raw).not.toContain("should-never-leak");
    expect(campaignClaimMock).toHaveBeenCalledOnce();
  });
});
