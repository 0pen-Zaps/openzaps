import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  start: vi.fn(),
  workflow: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({
  start: mocks.start,
}));
vi.mock("@/lib/leads/notification-server", () => ({
  leadNotificationDeliveryConfigured: mocks.configured,
}));
vi.mock("@/workflows/lead-notification", () => ({
  openZapsLeadNotificationWorkflow: mocks.workflow,
}));
vi.mock("@/lib/leads/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/server")>()),
  purgeExpiredLeadRequests: vi.fn(),
}));

import { purgeExpiredLeadRequests } from "@/lib/leads/server";
import { GET } from "./route";

const mockedPurge = vi.mocked(purgeExpiredLeadRequests);

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/leads/retention", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

beforeEach(() => {
  mocks.configured.mockReturnValue(true);
  mocks.start.mockResolvedValue({ runId: "wrun_lead_notification_1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("GET /api/leads/retention", () => {
  it("requires the Vercel cron credential", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");

    const response = await GET(request("wrong"));

    expect(response.status).toBe(401);
    expect(mockedPurge).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("deletes expired inactive leads without returning lead data", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    mockedPurge.mockResolvedValue(3);

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      purged: true,
      deletedCount: 3,
      deliveryQueued: true,
    });
    expect(mocks.start).toHaveBeenCalledWith(mocks.workflow);
    expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPurge.mock.invocationCallOrder[0] as number,
    );
  });

  it("keeps retention successful when recovery enqueueing fails", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    mocks.start.mockRejectedValue(new Error("workflow unavailable"));
    mockedPurge.mockResolvedValue(2);

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      purged: true,
      deletedCount: 2,
      deliveryQueued: false,
    });
    expect(mockedPurge).toHaveBeenCalledOnce();
  });

  it("skips recovery enqueueing when notification delivery is not ready", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    mocks.configured.mockReturnValue(false);
    mockedPurge.mockResolvedValue(0);

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      purged: true,
      deletedCount: 0,
      deliveryQueued: false,
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("fails closed when retention storage is unavailable", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    mockedPurge.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request("cron-token"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Lead retention could not be completed.",
    });
  });
});
