import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  TutorialPublicationReceiptError,
  recordTutorialPublicationReceipt,
  tutorialPublicationManifestEntry,
  tutorialPublicationManifestPatch,
  type TutorialPublicationReceiptInput,
} from "@/lib/marketing/tutorial-publication-receipt-server";

const ENV = {
  OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
  OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
} as const;

const INPUT: TutorialPublicationReceiptInput = {
  tutorialId: "paper-trade-first-authority-map",
  runId: "wrun_substack_1",
  candidateId: "draft:paper-trade:substack",
  sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
  sourceSha256: "a".repeat(64),
  bodySha256: "b".repeat(64),
  approvedTitle: "Paper Trade First",
  canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
  feedUrl: "https://defitutorials.substack.com/feed",
  publishedAt: "2026-08-01T01:00:00.000Z",
  rssCheckedAt: "2026-08-01T02:00:00.000Z",
};

function responseRow(overrides: Record<string, unknown> = {}): Response {
  return Response.json([{
    result_code: "recorded",
    tutorial_id: INPUT.tutorialId,
    run_id: INPUT.runId,
    candidate_id: INPUT.candidateId,
    source_path: INPUT.sourcePath,
    source_sha256: INPUT.sourceSha256,
    body_sha256: INPUT.bodySha256,
    approved_title: INPUT.approvedTitle,
    canonical_url: INPUT.canonicalUrl,
    feed_url: INPUT.feedUrl,
    published_at: INPUT.publishedAt,
    rss_checked_at: INPUT.rssCheckedAt,
    recorded_at: "2026-08-01T02:00:01.000Z",
    ...overrides,
  }]);
}

describe("durable tutorial publication receipt", () => {
  it("records the exact RSS evidence through the service-role-only RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseRow());

    const receipt = await recordTutorialPublicationReceipt(INPUT, {
      env: ENV,
      fetchImpl: fetchMock,
    });

    expect(receipt).toEqual({
      result: "recorded",
      ...INPUT,
      recordedAt: "2026-08-01T02:00:01.000Z",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/record_marketing_tutorial_publication_receipt",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({
        p_tutorial_id: INPUT.tutorialId,
        p_run_id: INPUT.runId,
        p_candidate_id: INPUT.candidateId,
        p_source_path: INPUT.sourcePath,
        p_source_sha256: INPUT.sourceSha256,
        p_body_sha256: INPUT.bodySha256,
        p_approved_title: INPUT.approvedTitle,
        p_canonical_url: INPUT.canonicalUrl,
        p_feed_url: INPUT.feedUrl,
        p_published_at: INPUT.publishedAt,
        p_rss_checked_at: INPUT.rssCheckedAt,
      }),
    });
    expect(init.headers).toMatchObject({
      apikey: "service-secret",
      authorization: "Bearer service-secret",
    });
  });

  it("returns an exact copyable manifest replacement", async () => {
    const receipt = await recordTutorialPublicationReceipt(INPUT, {
      env: ENV,
      fetchImpl: vi.fn().mockResolvedValue(
        responseRow({ result_code: "already_recorded" }),
      ),
    });
    const entry = tutorialPublicationManifestEntry(receipt);

    expect(receipt.result).toBe("already_recorded");
    expect(entry).toEqual({
      id: INPUT.tutorialId,
      title: INPUT.approvedTitle,
      sourcePath: INPUT.sourcePath,
      status: "rss_confirmed",
      canonicalUrl: INPUT.canonicalUrl,
      publishedAt: INPUT.publishedAt,
    });
    expect(tutorialPublicationManifestPatch(entry)).toBe(
      JSON.stringify(entry, null, 2),
    );
  });

  it("rejects invalid inputs before making a provider call", async () => {
    const fetchMock = vi.fn();

    await expect(
      recordTutorialPublicationReceipt(
        { ...INPUT, sourcePath: "docs/tutorials/other.md" },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      recordTutorialPublicationReceipt(
        { ...INPUT, canonicalUrl: `${INPUT.canonicalUrl}?draft=1` },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      recordTutorialPublicationReceipt(
        { ...INPUT, rssCheckedAt: "2026-08-01T00:00:00.000Z" },
        { env: ENV, fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for an immutable tuple conflict", async () => {
    await expect(
      recordTutorialPublicationReceipt(INPUT, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({
            result_code: "conflict",
            canonical_url:
              "https://defitutorials.substack.com/p/different-publication",
          }),
        ),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<TutorialPublicationReceiptError>>({
        code: "conflict",
      }),
    );
  });

  it("fails closed for missing configuration, network errors, and mismatched evidence", async () => {
    const fetchMock = vi.fn();
    await expect(
      recordTutorialPublicationReceipt(INPUT, { env: {}, fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();

    const secret = ENV.SUPABASE_SERVICE_ROLE_KEY;
    let networkError: unknown;
    try {
      await recordTutorialPublicationReceipt(INPUT, {
        env: ENV,
        fetchImpl: vi.fn().mockRejectedValue(new Error(`leaked ${secret}`)),
      });
    } catch (error) {
      networkError = error;
    }
    expect(networkError).toMatchObject({ code: "network_error" });
    expect((networkError as Error).message).not.toContain(secret);

    await expect(
      recordTutorialPublicationReceipt(INPUT, {
        env: ENV,
        fetchImpl: vi.fn().mockResolvedValue(
          responseRow({ body_sha256: "c".repeat(64) }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
