import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configuredMock, discoverMock } = vi.hoisted(() => ({
  configuredMock: vi.fn(),
  discoverMock: vi.fn(),
}));

vi.mock("@/lib/marketing/syndication-server", () => ({
  discoverMarketingSyndication: discoverMock,
  marketingSyndicationConfigured: configuredMock,
}));

import { GET } from "./route";

function request(token = "cron-token"): Request {
  return new Request(
    "https://www.0xzaps.com/api/marketing/syndication/cron",
    { headers: { authorization: `Bearer ${token}` } },
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-token");
  configuredMock.mockReturnValue(true);
  discoverMock.mockResolvedValue({
    sources: [
      {
        source: "openzaps",
        result: "discovered",
        discoveredCount: 4,
        baselineCount: 0,
        pendingCount: 1,
        existingCount: 3,
        checkedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        source: "defitutorials",
        result: "not_modified",
        discoveredCount: 0,
        baselineCount: 0,
        pendingCount: 0,
        existingCount: 0,
        checkedAt: "2026-08-01T12:00:00.000Z",
      },
    ],
    discoveredCount: 4,
    pendingCount: 1,
    providerWritesAttempted: false,
    workflowsStarted: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing syndication discovery cron", () => {
  it("authenticates before discovery", async () => {
    const response = await GET(request("wrong"));

    expect(response.status).toBe(401);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("fails closed before discovery when the durable inbox is absent", async () => {
    configuredMock.mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("discovers public metadata without starting workflows or provider writes", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({
      pendingCount: 1,
      providerWritesAttempted: false,
      workflowsStarted: false,
    });
    expect(discoverMock).toHaveBeenCalledOnce();
  });

  it("sanitizes discovery failures and makes no workflow claim", async () => {
    discoverMock.mockRejectedValue(new Error("service secret should-never-leak"));

    const response = await GET(request());
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("no publishing workflow was started");
    expect(raw).not.toContain("should-never-leak");
  });
});
