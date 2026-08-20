import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableCampaigns: vi.fn(),
}));

vi.mock(
  "@/lib/marketing/scheduled-template",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/lib/marketing/scheduled-template")
    >();
    mocks.availableCampaigns.mockImplementation(
      actual.availableReviewOnlyMarketingCampaigns,
    );
    return {
      ...actual,
      availableReviewOnlyMarketingCampaigns: mocks.availableCampaigns,
    };
  },
);

import { GET } from "./route";

function request(token?: string): Request {
  return new Request(
    "https://www.0xzaps.com/api/marketing/campaigns/review-only",
    {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T00:23:00.000Z"));
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("review-only marketing campaign route", () => {
  it("authenticates before reading any source-controlled campaign", async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ error: "Unauthorized." });
    expect(mocks.availableCampaigns).not.toHaveBeenCalled();
  });

  it("returns exact source artifacts only inside the manual-publication window", async () => {
    const response = await GET(request("operator-secret"));
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      evaluatedAt: string;
      campaigns: Array<Record<string, unknown>>;
      ownerReviewRequired: boolean;
      automaticQueueEligible: boolean;
      workflowsStarted: boolean;
      providerWritesAttempted: boolean;
      writesPerformed: boolean;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.availableCampaigns).toHaveBeenCalledWith(
      "2026-08-03T00:23:00.000Z",
    );
    expect(body).toMatchObject({
      schemaVersion: 1,
      service: "OpenZaps review-only campaign artifacts",
      evaluatedAt: "2026-08-03T00:23:00.000Z",
      ownerReviewRequired: true,
      automaticQueueEligible: false,
      workflowsStarted: false,
      providerWritesAttempted: false,
      writesPerformed: false,
    });
    expect(body.campaigns).toHaveLength(2);
    expect(body.campaigns.map((campaign) => ({
      id: campaign.id,
      channel: campaign.channel,
      contentHash: campaign.contentHash,
      notBefore: campaign.notBefore,
      notAfter: campaign.notAfter,
      canonicalSourceUrls: campaign.canonicalSourceUrls,
    }))).toEqual([
      {
        id: "fee-rewards-campaign-v1",
        channel: "x",
        contentHash:
          "69c67b003586adec1309b417161b967d4ff3003b26a208bfec29ea705082c749",
        notBefore: "2026-08-03T00:23:00.000Z",
        notAfter: "2026-08-10T00:23:00.000Z",
        canonicalSourceUrls: [
          "https://www.0xzaps.com/rewards",
          "https://www.0xzaps.com/api/protocol/rewards",
        ],
      },
      {
        id: "fee-rewards-campaign-v1",
        channel: "discord",
        contentHash:
          "5eecd470a6a8c17969993edb82aa85338205b0fb7ffbbe31e82597a1a068cc6c",
        notBefore: "2026-08-03T00:23:00.000Z",
        notAfter: "2026-08-10T00:23:00.000Z",
        canonicalSourceUrls: [
          "https://www.0xzaps.com/rewards",
          "https://www.0xzaps.com/api/protocol/rewards",
        ],
      },
    ]);
    for (const campaign of body.campaigns) {
      expect(campaign).toMatchObject({
        queueOrder: expect.any(Number),
        links: ["https://www.0xzaps.com/rewards"],
        topics: ["token", "trading"],
        disclosures: ["pre_audit"],
        requiredFacts: [
          {
            key: "product.fee_rewards_terms",
            sourceUrl: "https://www.0xzaps.com/rewards",
          },
          {
            key: "product.fee_rewards_active_snapshot",
            sourceUrl: "https://www.0xzaps.com/api/protocol/rewards",
          },
        ],
        flags: {
          containsCredential: false,
          guaranteesReturns: false,
          impersonatesPerson: false,
          requestsPolicyBypass: false,
          unsolicitedBulkMessaging: false,
          usesUnavailableAsZero: false,
        },
      });
      expect(typeof campaign.body).toBe("string");
      expect(campaign.body).toContain("Verify before use.");
      expect(Array.isArray(campaign.claims)).toBe(true);
    }
    expect(raw).not.toContain("operator-secret");
  });

  it("honors the exclusive end without starting work or calling a provider", async () => {
    vi.setSystemTime(new Date("2026-08-10T00:23:00.000Z"));

    const response = await GET(request("operator-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      evaluatedAt: "2026-08-10T00:23:00.000Z",
      campaigns: [],
      ownerReviewRequired: true,
      automaticQueueEligible: false,
      workflowsStarted: false,
      providerWritesAttempted: false,
      writesPerformed: false,
    });
  });

  it("sanitizes internal source failures", async () => {
    mocks.availableCampaigns.mockImplementationOnce(() => {
      throw new Error("source registry included server-only-secret");
    });

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      error: "Review-only campaign artifacts could not be loaded.",
      ownerReviewRequired: true,
      automaticQueueEligible: false,
      workflowsStarted: false,
      providerWritesAttempted: false,
      writesPerformed: false,
    });
    expect(raw).not.toContain("server-only-secret");
  });
});
