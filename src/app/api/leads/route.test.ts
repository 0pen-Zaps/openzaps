import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leads/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/server")>()),
  listLeadRequests: vi.fn(),
}));

import { listLeadRequests } from "@/lib/leads/server";
import { GET } from "./route";

const mockedList = vi.mocked(listLeadRequests);
const TOKEN = "lead-desk-token-that-is-at-least-32-bytes";

function request(
  query = "",
  token = TOKEN,
): Request {
  return new Request(`https://www.0xzaps.com/api/leads${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("GET /api/leads", () => {
  it("requires the separately scoped lead-desk credential", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    const response = await GET(request("", "wrong"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns the private, non-cacheable operator queue", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    mockedList.mockResolvedValue([
      {
        id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
        persona: "protocol_team",
        name: "Partner",
        email: "partner@example.com",
        emailVerified: false,
        project: "Protocol",
        projectUrl: "https://example.com",
        workflow: "A bounded workflow with enough detail for review.",
        protocolsAssets: "USDC",
        trigger: "Verified event",
        guardrails: "A strict spend cap",
        timeline: "within_30_days",
        consentToContact: true,
        consentVersion: "lead-contact-v1",
        consentedAt: "2026-07-30T02:00:00.000Z",
        attribution: {},
        qualificationScore: 5,
        status: "new",
        createdAt: "2026-07-30T02:00:00.000Z",
        updatedAt: "2026-07-30T02:00:00.000Z",
        expiresAt: "2027-01-26T02:00:00.000Z",
      },
    ]);

    const response = await GET(request("?limit=25&minScore=3"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockedList).toHaveBeenCalledWith({ limit: 25, minScore: 3 });
    expect(JSON.parse(raw)).toMatchObject({
      count: 1,
      leads: [{
        email: "partner@example.com",
        emailVerified: false,
        qualificationScore: 5,
      }],
    });
    expect(raw).not.toContain("fingerprint");
  });

  it("rejects unknown, repeated, and out-of-range query parameters", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    for (const query of [
      "?unknown=1",
      "?limit=1&limit=2",
      "?limit=101",
      "?minScore=6",
      "?limit=1.5",
    ]) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
    }
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("fails closed without returning storage details", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    mockedList.mockRejectedValue(new Error("service-secret database detail"));

    const response = await GET(request());
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("Lead queue could not be read.");
    expect(raw).not.toContain("service-secret");
  });
});
