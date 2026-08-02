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

function request(query = "", token = TOKEN): Request {
  return new Request(`https://www.0xzaps.com/api/leads/scorecard${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("GET /api/leads/scorecard", () => {
  it("requires the separately scoped lead-desk credential", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    const response = await GET(request("", "wrong"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns a private PII-free aggregate over the bounded current queue", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    mockedList.mockResolvedValue([
      {
        id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
        persona: "protocol_team",
        name: "Private person",
        email: "private@example.com",
        emailVerified: false,
        project: "Private project",
        projectUrl: "https://example.com/private",
        workflow: "A private workflow with enough detail for review.",
        protocolsAssets: "USDC",
        trigger: "Verified event",
        guardrails: "A strict spend cap",
        timeline: "within_30_days",
        consentToContact: true,
        consentVersion: "lead-contact-v1",
        consentedAt: "2026-08-05T15:00:00.000Z",
        attribution: {
          utmSource: "Private Person",
          utmCampaign: "12125551212",
          utmContent: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
          referrer: "https://192.0.2.1/private-path",
        },
        qualificationScore: 5,
        status: "new",
        createdAt: "2026-08-05T15:00:00.000Z",
        updatedAt: "2026-08-05T15:00:00.000Z",
        expiresAt: "2027-02-01T15:00:00.000Z",
      },
    ]);

    const response = await GET(request());
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockedList).toHaveBeenCalledWith({ limit: 100, minScore: 0 });
    expect(body).toMatchObject({
      scorecard: {
        schemaVersion: 1,
        scope: { basis: "accepted_requests_onward", returnedRows: 1 },
        windows: { days7: { accepted: 1, score3Plus: 1 } },
        stages: { new: 1 },
      },
    });
    expect(raw).not.toMatch(
      /private person|private@example\.com|private project|private workflow|example\.com\/private|12125551212|192\.0\.2\.1|019fab5e-be72-72d2-809b-0a1d4a35c86b|2026-08-05T15:00:00\.000Z/iu,
    );
    expect(body).toMatchObject({
      scorecard: {
        attribution: [{
          source: "other",
          campaign: "other",
          content: "other",
        }],
      },
    });
  });

  it("rejects every query parameter", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    expect((await GET(request("?limit=1"))).status).toBe(400);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("fails closed without returning storage details", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    mockedList.mockRejectedValue(new Error("service-secret database detail"));

    const response = await GET(request());
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("Lead scorecard could not be read.");
    expect(raw).not.toContain("service-secret");
  });
});
