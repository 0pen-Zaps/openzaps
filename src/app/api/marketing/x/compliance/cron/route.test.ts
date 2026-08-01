import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(() => true),
  lookupSubjects: vi.fn(),
  verifyIdentity: vi.fn(),
  configured: vi.fn(() => true),
  initializeAccount: vi.fn(),
  listSubjects: vi.fn(),
  recordCheckpoint: vi.fn(),
}));

vi.mock("@/lib/cron-auth", () => ({
  isCronAuthorized: mocks.authorized,
}));
vi.mock("@/lib/marketing/channels/x", () => ({
  lookupXComplianceSubjects: mocks.lookupSubjects,
  verifyXAuthenticatedIdentity: mocks.verifyIdentity,
}));
vi.mock("@/lib/marketing/x-compliance-server", () => ({
  initializeMarketingXComplianceAccount: mocks.initializeAccount,
  listMarketingXComplianceSubjects: mocks.listSubjects,
  marketingXComplianceConfigured: mocks.configured,
  recordMarketingXComplianceCheckpoint: mocks.recordCheckpoint,
}));

import { GET } from "./route";
import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

const ACCOUNT_ID = "999999";
const CHECKED_AT = "2026-08-01T12:00:00.000Z";

function request(): Request {
  return new Request(
    "https://www.0xzaps.com/api/marketing/x/compliance/cron",
    { headers: { authorization: "Bearer cron" } },
  );
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_X_COMPLIANCE_MONITOR_ENABLED", "true");
  vi.stubEnv("X_EXPECTED_ACCOUNT_ID", ACCOUNT_ID);
  mocks.authorized.mockReturnValue(true);
  mocks.configured.mockReturnValue(true);
  mocks.verifyIdentity.mockResolvedValue({
    authenticatedAccountId: ACCOUNT_ID,
    authenticatedUsername: "openzaps",
    observedAt: CHECKED_AT,
  });
  mocks.initializeAccount.mockResolvedValue({
    result: "created",
    accountId: ACCOUNT_ID,
    eligibilityCutoffAt: CHECKED_AT,
  });
  mocks.listSubjects.mockResolvedValue({
    result: "listed",
    accountId: ACCOUNT_ID,
    subjectCount: 1,
    subjects: [{ subjectKind: "account", subjectId: ACCOUNT_ID }],
  });
  mocks.lookupSubjects.mockImplementation(
    async (input: { postIds: string[]; userIds: string[] }) => ({
      authenticatedAccountId: ACCOUNT_ID,
      observedAt: CHECKED_AT,
      observations: [
        ...input.postIds.map((subjectId) => ({
          subjectKind: "post" as const,
          subjectId,
          status: "present" as const,
        })),
        ...input.userIds.map((subjectId) => ({
          subjectKind: "user" as const,
          subjectId,
          status: "present" as const,
        })),
      ],
    }),
  );
  mocks.recordCheckpoint.mockResolvedValue({
    result: "recorded",
    checkpointId: "00000000-0000-4000-8000-000000000001",
    checkedAt: CHECKED_AT,
    validUntil: "2026-08-01T12:30:00.000Z",
    subjectCount: 1,
    nonPresentCount: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("X compliance cron", () => {
  it("rejects unauthorized invocations before database or provider reads", async () => {
    mocks.authorized.mockReturnValue(false);

    const result = await GET(request());

    expect(result.status).toBe(401);
    expect(mocks.listSubjects).not.toHaveBeenCalled();
    expect(mocks.lookupSubjects).not.toHaveBeenCalled();
  });

  it("batches provider lookups at 100 and preserves account versus author kinds", async () => {
    const authors = Array.from({ length: 101 }, (_, index) => ({
      subjectKind: "author" as const,
      subjectId: String(100_000 + index),
    }));
    const posts = Array.from({ length: 201 }, (_, index) => ({
      subjectKind: "post" as const,
      subjectId: String(200_000 + index),
    }));
    const subjects = [
      { subjectKind: "account" as const, subjectId: ACCOUNT_ID },
      ...authors,
      ...posts,
    ];
    mocks.listSubjects.mockResolvedValue({
      result: "listed",
      accountId: ACCOUNT_ID,
      subjectCount: subjects.length,
      subjects,
    });
    mocks.recordCheckpoint.mockResolvedValue({
      result: "recorded",
      checkpointId: "00000000-0000-4000-8000-000000000001",
      checkedAt: CHECKED_AT,
      validUntil: "2026-08-01T12:30:00.000Z",
      subjectCount: subjects.length,
      nonPresentCount: 0,
    });

    const result = await GET(request());

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      healthy: true,
      result: "recorded",
      subjectCount: subjects.length,
      providerWritesAttempted: false,
    });
    expect(mocks.listSubjects).toHaveBeenCalledWith(ACCOUNT_ID, 5_000);
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.initializeAccount).not.toHaveBeenCalled();
    expect(mocks.lookupSubjects).toHaveBeenCalledTimes(3);
    for (const [input] of mocks.lookupSubjects.mock.calls as Array<[
      { postIds: string[]; userIds: string[] },
    ]>) {
      expect(input.postIds.length).toBeLessThanOrEqual(100);
      expect(input.userIds.length).toBeLessThanOrEqual(100);
    }
    const checkpoint = mocks.recordCheckpoint.mock.calls[0]?.[0] as {
      observations: Array<{
        subjectKind: "account" | "post" | "author";
        subjectId: string;
        outcome: string;
      }>;
    };
    expect(checkpoint.observations).toHaveLength(subjects.length);
    expect(checkpoint.observations).toContainEqual({
      subjectKind: "account",
      subjectId: ACCOUNT_ID,
      outcome: "present",
    });
    expect(checkpoint.observations).toContainEqual({
      subjectKind: "author",
      subjectId: authors[0]?.subjectId,
      outcome: "present",
    });
    expect(checkpoint.observations).toContainEqual({
      subjectKind: "post",
      subjectId: posts[0]?.subjectId,
      outcome: "present",
    });
  });

  it("binds a fresh store to the official identity before its first checkpoint", async () => {
    mocks.listSubjects
      .mockResolvedValueOnce({
        result: "account_not_found",
        accountId: ACCOUNT_ID,
        subjectCount: 0,
        subjects: [],
      })
      .mockResolvedValueOnce({
        result: "listed",
        accountId: ACCOUNT_ID,
        subjectCount: 1,
        subjects: [{ subjectKind: "account", subjectId: ACCOUNT_ID }],
      });

    const result = await GET(request());

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      healthy: true,
      result: "recorded",
      bootstrapped: true,
      subjectCount: 1,
      providerWritesAttempted: false,
    });
    expect(mocks.verifyIdentity).toHaveBeenCalledWith({
      requestTimeoutMs: 8_000,
    });
    expect(mocks.initializeAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      verifiedAt: CHECKED_AT,
    });
    expect(mocks.listSubjects).toHaveBeenCalledTimes(2);
    expect(mocks.verifyIdentity).toHaveBeenCalledBefore(mocks.initializeAccount);
    expect(mocks.initializeAccount).toHaveBeenCalledBefore(mocks.lookupSubjects);
    expect(mocks.lookupSubjects).toHaveBeenCalledBefore(mocks.recordCheckpoint);
  });

  it("fails closed before initialization when the official identity differs", async () => {
    mocks.listSubjects.mockResolvedValue({
      result: "account_not_found",
      accountId: ACCOUNT_ID,
      subjectCount: 0,
      subjects: [],
    });
    mocks.verifyIdentity.mockResolvedValue({
      authenticatedAccountId: "123456",
      authenticatedUsername: "different",
      observedAt: CHECKED_AT,
    });

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "X compliance reconciliation failed closed.",
      providerWritesAttempted: false,
    });
    expect(mocks.initializeAccount).not.toHaveBeenCalled();
    expect(mocks.lookupSubjects).not.toHaveBeenCalled();
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
  });

  it("records provider protection as action-required and fails closed", async () => {
    mocks.listSubjects.mockResolvedValue({
      result: "listed",
      accountId: ACCOUNT_ID,
      subjectCount: 2,
      subjects: [
        { subjectKind: "account", subjectId: ACCOUNT_ID },
        { subjectKind: "author", subjectId: "123456" },
      ],
    });
    mocks.lookupSubjects.mockResolvedValue({
      authenticatedAccountId: ACCOUNT_ID,
      observedAt: CHECKED_AT,
      observations: [
        { subjectKind: "user", subjectId: ACCOUNT_ID, status: "present" },
        { subjectKind: "user", subjectId: "123456", status: "protected" },
      ],
    });
    mocks.recordCheckpoint.mockResolvedValue({
      result: "action_required",
      checkpointId: "00000000-0000-4000-8000-000000000002",
      checkedAt: CHECKED_AT,
      validUntil: "2026-08-01T12:30:00.000Z",
      subjectCount: 2,
      nonPresentCount: 1,
    });

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      healthy: false,
      result: "action_required",
      suppressedCount: 1,
      providerWritesAttempted: false,
    });
    expect(mocks.recordCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      observations: [
        { subjectKind: "account", subjectId: ACCOUNT_ID, outcome: "present" },
        { subjectKind: "author", subjectId: "123456", outcome: "protected" },
      ],
    }));
  });

  it("stops without provider work when the durable subject bound is exceeded", async () => {
    mocks.listSubjects.mockResolvedValue({
      result: "limit_exceeded",
      accountId: ACCOUNT_ID,
      subjectCount: 5_001,
      subjects: [],
    });

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "The X compliance subject limit was exceeded.",
    });
    expect(mocks.lookupSubjects).not.toHaveBeenCalled();
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
  });

  it("sanitizes an authenticated-account mismatch and records no checkpoint", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.lookupSubjects.mockResolvedValue({
      authenticatedAccountId: "123456",
      observedAt: CHECKED_AT,
      observations: [
        { subjectKind: "user", subjectId: ACCOUNT_ID, status: "present" },
      ],
    });

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "X compliance reconciliation failed closed.",
      providerWritesAttempted: false,
    });
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
      event: "marketing_x_compliance_reconciliation_failed",
      stage: "lookup_subjects",
      errorCode: "internal-error",
    }));
  });

  it("logs only a fixed provider failure classification", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.lookupSubjects.mockRejectedValue(new ChannelAdapterError(
      "x",
      "provider-error",
      "provider response that must not enter logs",
      { status: 402 },
    ));

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "X compliance reconciliation failed closed.",
      providerWritesAttempted: false,
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
      event: "marketing_x_compliance_reconciliation_failed",
      stage: "lookup_subjects",
      errorCode: "provider-error",
      providerStatus: 402,
    }));
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain(
      "provider response that must not enter logs",
    );
  });
});
