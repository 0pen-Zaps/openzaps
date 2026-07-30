import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
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
    });
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
