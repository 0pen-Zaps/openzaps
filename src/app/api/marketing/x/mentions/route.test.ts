import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
  list: vi.fn(),
}));

vi.mock("@/lib/marketing/auth", () => ({
  isMarketingAdminAuthorized: mocks.authorized,
  marketingAdminUnauthorizedResponse: mocks.unauthorized,
}));
vi.mock("@/lib/marketing/x-mentions-server", () => ({
  listXMentionInbox: mocks.list,
}));

import { GET } from "./route";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("X mention admin inbox", () => {
  it("returns only metadata and canonical public links to an authorized operator", async () => {
    mocks.authorized.mockReturnValue(true);
    vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
    mocks.list.mockResolvedValue({
      result: "listed",
      reviewRequiredCount: 1,
      items: [{
        postId: "123456789",
        authorId: "200",
        conversationId: "123456789",
        createdAt: "2026-08-01T15:00:00.000Z",
        contentHmac: "a".repeat(64),
        classification: "review",
        eligibilityReason: "sensitive_or_ambiguous_topic",
        state: "review_required",
        discoveredAt: "2026-08-01T15:01:00.000Z",
        stateChangedAt: "2026-08-01T15:01:00.000Z",
        claimDay: null,
        claimedAt: null,
        repliedAt: null,
        failedAt: null,
        failureCode: null,
      }],
    });

    const result = await GET(new Request("https://www.0xzaps.com/api/marketing/x/mentions"));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toEqual({
      result: "listed",
      reviewRequiredCount: 1,
      items: [{
        targetUrl: "https://x.com/i/web/status/123456789",
        createdAt: "2026-08-01T15:00:00.000Z",
        classification: "review",
        reason: "sensitive_or_ambiguous_topic",
        state: "review_required",
        discoveredAt: "2026-08-01T15:01:00.000Z",
        stateChangedAt: "2026-08-01T15:01:00.000Z",
        failureCode: null,
      }],
      rawPostTextStored: false,
    });
    expect(JSON.stringify(body)).not.toContain("authorId");
    expect(JSON.stringify(body)).not.toContain("contentHmac");
  });

  it("rejects an unauthorized request before database access", async () => {
    mocks.authorized.mockReturnValue(false);
    const result = await GET(new Request("https://www.0xzaps.com/api/marketing/x/mentions"));
    expect(result.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
