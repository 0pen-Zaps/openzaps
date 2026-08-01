import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const channel = vi.hoisted(() => ({
  postReply: vi.fn(),
  verifyTarget: vi.fn(),
}));

vi.mock("@/lib/marketing/channels/x", () => ({
  postXReply: channel.postReply,
  verifyXReplyTarget: channel.verifyTarget,
}));

import {
  admitMarketingXOutboundDelivery,
  checkMarketingXOutboundAdmission,
  claimMarketingXReplySubject,
  createMarketingXReplySubject,
  finalizeMarketingXOutboundAdmission,
  getMarketingXComplianceHealth,
  getMarketingXReplySubject,
  initializeMarketingXComplianceAccount,
  listMarketingXComplianceSubjects,
  postMarketingXReplyFromSubject,
  purgeMarketingXRetention,
  recordMarketingXComplianceCheckpoint,
} from "./x-compliance-server";

const ENV = {
  NODE_ENV: "production",
  OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
  OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
} as const;
const REFERENCE = "8".repeat(30);
const CLAIM_TOKEN = "00000000-0000-4000-8000-000000000001";
const ADMISSION_TOKEN = "00000000-0000-4000-8000-000000000002";
const OBSERVED_AT = "2026-08-01T12:00:00.000Z";

function jsonRow(row: Record<string, unknown>): Response {
  return Response.json([row]);
}

function safeSubject(resultCode: "created" | "found") {
  return {
    result_code: resultCode,
    interaction_reference: REFERENCE,
    trigger: "mention",
    observed_at: OBSERVED_AT,
    expires_at: "2026-08-02T12:00:00.000Z",
  };
}

function claimedSubject() {
  return {
    result_code: "claimed",
    interaction_reference: REFERENCE,
    claim_token: CLAIM_TOKEN,
    claim_expires_at: "2026-08-01T12:05:00.000Z",
    account_id: "100",
    post_id: "123456789",
    author_id: "200",
    target_url: "https://x.com/community/status/123456789",
    trigger: "mention",
    observed_at: OBSERVED_AT,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("X compliance store adapter", () => {
  it("initializes only the exact identity-bound account boundary", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow({
        result_code: "created",
        account_id: "100",
        eligibility_cutoff_at: OBSERVED_AT,
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "already_exists",
        account_id: "100",
        eligibility_cutoff_at: OBSERVED_AT,
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "already_exists",
        account_id: "100",
        eligibility_cutoff_at: OBSERVED_AT,
        initialized_at: OBSERVED_AT,
      }));

    await expect(initializeMarketingXComplianceAccount(
      { accountId: "100", verifiedAt: OBSERVED_AT },
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toEqual({
      result: "created",
      accountId: "100",
      eligibilityCutoffAt: OBSERVED_AT,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain(
      "/rpc/initialize_marketing_x_compliance_account",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      p_account_id: "100",
      p_verified_at: OBSERVED_AT,
    });

    await expect(initializeMarketingXComplianceAccount(
      { accountId: "100", verifiedAt: OBSERVED_AT },
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toEqual({
      result: "already_exists",
      accountId: "100",
      eligibilityCutoffAt: OBSERVED_AT,
    });

    await expect(initializeMarketingXComplianceAccount(
      { accountId: "100", verifiedAt: OBSERVED_AT },
      { env: ENV, fetchImpl: fetchMock },
    )).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("vaults raw provider metadata and returns only an opaque safe reference", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRow(safeSubject("created")));
    const result = await createMarketingXReplySubject(
      {
        postId: "123456789",
        targetUrl: "https://x.com/community/status/123456789",
        authorId: "200",
        authenticatedAccountId: "100",
        trigger: "mention",
        observedAt: OBSERVED_AT,
      },
      { env: ENV, fetchImpl: fetchMock },
    );

    expect(result).toEqual({
      result: "created",
      interaction: {
        id: REFERENCE,
        trigger: "mention",
        observedAt: OBSERVED_AT,
      },
      expiresAt: "2026-08-02T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("123456789");
    expect(JSON.stringify(result)).not.toContain("community");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain("/rpc/create_marketing_x_reply_subject");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer service-role-secret",
    );
  });

  it("reads only safe subject fields and rejects raw-field leakage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow(safeSubject("found")))
      .mockResolvedValueOnce(jsonRow({
        ...safeSubject("found"),
        post_id: "123456789",
      }));

    await expect(getMarketingXReplySubject(
      REFERENCE,
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toMatchObject({ result: "found" });

    await expect(getMarketingXReplySubject(
      REFERENCE,
      { env: ENV, fetchImpl: fetchMock },
    )).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("strictly parses subject claims and outbound admission state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow(claimedSubject()))
      .mockResolvedValueOnce(jsonRow({
        result_code: "admitted",
        admission_token: ADMISSION_TOKEN,
        admission_expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "allowed",
        allowed: true,
        expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "finalized",
        state: "completed",
        finalized_at: "2026-08-01T12:00:05.000Z",
      }));

    const claim = await claimMarketingXReplySubject(
      { interactionReference: REFERENCE, idempotencyKey: "reply:one" },
      { env: ENV, fetchImpl: fetchMock },
    );
    expect(claim).toMatchObject({
      result: "claimed",
      interactionReference: REFERENCE,
      postId: "123456789",
      authorId: "200",
      accountId: "100",
    });
    const admission = await admitMarketingXOutboundDelivery(
      {
        accountId: "100",
        interactionReference: REFERENCE,
        postId: "123456789",
        authorId: "200",
        sourceClaimToken: CLAIM_TOKEN,
        providerCheckedAt: OBSERVED_AT,
      },
      { env: ENV, fetchImpl: fetchMock },
    );
    expect(admission.result).toBe("admitted");
    await expect(checkMarketingXOutboundAdmission(
      ADMISSION_TOKEN,
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toMatchObject({ allowed: true });
    await expect(finalizeMarketingXOutboundAdmission(
      { admissionToken: ADMISSION_TOKEN, outcome: "completed" },
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toMatchObject({ state: "completed" });
  });

  it("uses the exact account/post/author checkpoint and retention contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow({
        result_code: "listed",
        account_id: "100",
        subject_count: 3,
        subjects: [
          { subject_kind: "account", subject_id: "100" },
          { subject_kind: "author", subject_id: "200" },
          { subject_kind: "post", subject_id: "123456789" },
        ],
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "recorded",
        checkpoint_id: "00000000-0000-4000-8000-000000000003",
        checked_at: OBSERVED_AT,
        valid_until: "2026-08-01T12:30:00.000Z",
        subject_count: 3,
        non_present_count: 0,
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "healthy",
        checkpoint_id: "00000000-0000-4000-8000-000000000003",
        checked_at: OBSERVED_AT,
        valid_until: "2026-08-01T12:30:00.000Z",
        subject_count: 3,
        non_present_count: 0,
        hold: false,
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "purged",
        expired_subject_count: 1,
        deleted_mention_count: 2,
        deleted_opt_out_count: 3,
        deleted_admission_count: 4,
        deleted_checkpoint_count: 5,
        deleted_compliance_event_count: 6,
        reset_cursor_count: 7,
        processed_at: OBSERVED_AT,
      }));

    await expect(listMarketingXComplianceSubjects(
      "100",
      5_000,
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toEqual({
      result: "listed",
      accountId: "100",
      subjectCount: 3,
      subjects: [
        { subjectKind: "account", subjectId: "100" },
        { subjectKind: "author", subjectId: "200" },
        { subjectKind: "post", subjectId: "123456789" },
      ],
    });
    await expect(recordMarketingXComplianceCheckpoint(
      {
        accountId: "100",
        providerRunId: "00000000-0000-4000-8000-000000000004",
        startedAt: "2026-08-01T11:59:59.000Z",
        completedAt: OBSERVED_AT,
        observations: [
          { subjectKind: "account", subjectId: "100", outcome: "present" },
          { subjectKind: "author", subjectId: "200", outcome: "present" },
          { subjectKind: "post", subjectId: "123456789", outcome: "present" },
        ],
      },
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toMatchObject({ result: "recorded", nonPresentCount: 0 });
    const checkpointBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(checkpointBody.p_observations).toEqual([
      { subject_kind: "account", subject_id: "100", outcome: "present" },
      { subject_kind: "author", subject_id: "200", outcome: "present" },
      { subject_kind: "post", subject_id: "123456789", outcome: "present" },
    ]);
    expect(JSON.stringify(checkpointBody)).not.toContain("status");

    await expect(getMarketingXComplianceHealth(
      "100",
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toMatchObject({ result: "healthy", hold: false });
    await expect(purgeMarketingXRetention(
      OBSERVED_AT,
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toEqual({
      result: "purged",
      expiredSubjectCount: 1,
      deletedMentionCount: 2,
      deletedOptOutCount: 3,
      deletedAdmissionCount: 4,
      deletedCheckpointCount: 5,
      deletedComplianceEventCount: 6,
      resetCursorCount: 7,
      processedAt: OBSERVED_AT,
    });
  });

  it("accepts a bounded subject-limit response without treating it as coverage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRow({
      result_code: "limit_exceeded",
      account_id: "100",
      subject_count: 5_001,
      subjects: [],
    }));
    await expect(listMarketingXComplianceSubjects(
      "100",
      5_000,
      { env: ENV, fetchImpl: fetchMock },
    )).resolves.toEqual({
      result: "limit_exceeded",
      accountId: "100",
      subjectCount: 5_001,
      subjects: [],
    });
  });

  it("accepts the complete 5000-subject inventory within a finite response cap", async () => {
    const subjects = [
      { subject_kind: "account", subject_id: "100" },
      ...Array.from({ length: 4_999 }, (_, index) => ({
        subject_kind: "post",
        subject_id: String(9_000_000_000_000_000_000n + BigInt(index)),
      })),
    ];
    const row = {
      result_code: "listed",
      account_id: "100",
      subject_count: subjects.length,
      subjects,
    };
    expect(JSON.stringify([row]).length).toBeGreaterThan(256 * 1_024);
    const fetchMock = vi.fn().mockResolvedValue(jsonRow(row));

    const result = await listMarketingXComplianceSubjects(
      "100",
      5_000,
      { env: ENV, fetchImpl: fetchMock },
    );

    expect(result.result).toBe("listed");
    expect(result.subjectCount).toBe(5_000);
    expect(result.subjects).toHaveLength(5_000);
  });

  it("keeps raw ids inside one final step and fences immediately before POST", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow(claimedSubject()))
      .mockResolvedValueOnce(jsonRow({
        result_code: "admitted",
        admission_token: ADMISSION_TOKEN,
        admission_expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "allowed",
        allowed: true,
        expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "finalized",
        state: "completed",
        finalized_at: "2026-08-01T12:00:05.000Z",
      }));
    channel.verifyTarget.mockResolvedValue({
      postId: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger: "mention",
      observedAt: OBSERVED_AT,
    });
    channel.postReply.mockResolvedValue({
      channel: "x",
      mode: "reply",
      providerMessageId: "300",
      providerUrl: "https://x.com/i/web/status/300",
      idempotencyKey: "reply:one",
    });

    const receipt = await postMarketingXReplyFromSubject(
      {
        interactionReference: REFERENCE,
        text: "Bounded reply.",
        idempotencyKey: "reply:one",
      },
      { env: ENV, fetchImpl: fetchMock },
    );
    expect(receipt.providerMessageId).toBe("300");
    expect(channel.verifyTarget).toHaveBeenCalledBefore(channel.postReply);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0].pathname).toContain(
      "/rpc/check_marketing_x_outbound_admission",
    );
    expect(channel.postReply).toHaveBeenCalledWith(
      {
        text: "Bounded reply.",
        idempotencyKey: "reply:one",
        inReplyToTweetId: "123456789",
        authenticatedAccountId: "100",
      },
      undefined,
    );
  });

  it("never calls the provider when the final admission is revoked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow(claimedSubject()))
      .mockResolvedValueOnce(jsonRow({
        result_code: "admitted",
        admission_token: ADMISSION_TOKEN,
        admission_expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "revoked",
        allowed: false,
        expires_at: "2026-08-01T12:00:10.000Z",
      }))
      .mockResolvedValueOnce(jsonRow({
        result_code: "already_finalized",
        state: "revoked",
        finalized_at: "2026-08-01T12:00:01.000Z",
      }));
    channel.verifyTarget.mockResolvedValue({
      postId: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger: "mention",
      observedAt: OBSERVED_AT,
    });

    await expect(postMarketingXReplyFromSubject(
      {
        interactionReference: REFERENCE,
        text: "Do not send.",
        idempotencyKey: "reply:revoked",
      },
      { env: ENV, fetchImpl: fetchMock },
    )).rejects.toThrow("revoked");
    expect(channel.postReply).not.toHaveBeenCalled();
  });

  it.each([
    "not_found",
    "compliance_hold",
    "compliance_stale",
    "claim_conflict",
    "provider_check_stale",
    "subject_compliance_stale",
    "already_admitted",
    "already_consumed",
  ] as const)("fails closed before the provider for %s admission", async (denial) => {
    const existing = denial === "already_admitted" || denial === "already_consumed";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRow(claimedSubject()))
      .mockResolvedValueOnce(jsonRow({
        result_code: denial,
        admission_token: existing ? ADMISSION_TOKEN : null,
        admission_expires_at: existing
          ? "2026-08-01T12:00:10.000Z"
          : null,
      }));
    channel.verifyTarget.mockResolvedValue({
      postId: "123456789",
      targetUrl: "https://x.com/community/status/123456789",
      authorId: "200",
      authenticatedAccountId: "100",
      trigger: "mention",
      observedAt: OBSERVED_AT,
    });

    await expect(postMarketingXReplyFromSubject(
      {
        interactionReference: REFERENCE,
        text: "Do not send.",
        idempotencyKey: `reply:${denial}`,
      },
      { env: ENV, fetchImpl: fetchMock },
    )).rejects.toThrow(denial);
    expect(channel.postReply).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
