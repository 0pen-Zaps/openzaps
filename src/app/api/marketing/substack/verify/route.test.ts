import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRunMock, loadTutorialMock, verifyMock, recordReceiptMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
  loadTutorialMock: vi.fn(),
  verifyMock: vi.fn(),
  recordReceiptMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ getRun: getRunMock }));

vi.mock("@/lib/marketing/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketing/channels")>();
  return { ...actual, verifySubstackPublication: verifyMock };
});
vi.mock("@/lib/marketing/tutorial-handoff-source", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/marketing/tutorial-handoff-source")
  >();
  return {
    ...actual,
    loadSourceControlledTutorialApprovalBundle: loadTutorialMock,
  };
});
vi.mock(
  "@/lib/marketing/tutorial-publication-receipt-server",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/lib/marketing/tutorial-publication-receipt-server")
    >();
    return {
      ...actual,
      recordTutorialPublicationReceipt: recordReceiptMock,
    };
  },
);

import { ChannelAdapterError } from "@/lib/marketing/channels";
import { POST } from "./route";

const NOW = "2026-08-01T02:00:00.000Z";
const RUN_ID = "wrun_substack_1";
const CANDIDATE_ID = "draft:paper-trade:substack";
const CANONICAL_URL =
  "https://defitutorials.substack.com/p/paper-trade-first";

function workflowResult() {
  const sourcePacket = {
    id: "sources:paper-trade",
    createdAt: NOW,
    protocolPreAudit: true,
    facts: [{
      key: "virtual-trading",
      label: "Virtual Trading",
      value: "Wallet-free paper trading is live.",
      status: "confirmed",
      sourceUrl: "https://www.0xzaps.com/virtual-trading",
      observedAt: NOW,
    }],
    externalData: [],
    interaction: null,
  };
  const tutorialId = "paper-trade-first-authority-map";
  const sourceSha256 = "a".repeat(64);
  const bodySha256 = "b".repeat(64);
  const bodyMarkdown = [
    "Paper trade first, before granting an agent any onchain trigger.",
    "OpenZaps Virtual Trading uses read-only quotes and browser-local state, so a builder can inspect the route without connecting a wallet, approving a token, signing a message, or sending a transaction.",
    "That rehearsal is not a promise of execution or returns. OpenZaps remains pre-audit software; verify the exact policy, contracts, assets, limits, and recovery path before any live use.",
  ].join("\n\n");
  const tutorialHandoff = {
    version: 1,
    channel: "substack",
    status: "requires_owner_approval",
    tutorialId,
    manifestStatus: "draft",
    sourcePath: `docs/tutorials/${tutorialId}.md`,
    sourceSha256,
    bodySha256,
    title: "Paper Trade First",
    tags: ["OpenZaps", "DeFi"],
    topics: ["protocol", "simulation"],
    disclosures: ["pre_audit"],
    claims: [{
      text: "Virtual Trading is wallet-free.",
      factKeys: ["virtual-trading"],
      treatment: "asserted",
    }],
    links: ["https://www.0xzaps.com/virtual-trading"],
    bodyMarkdown,
    editorUrl: "https://defitutorials.substack.com/publish/post",
    publicationUrl: "https://defitutorials.substack.com",
    modelRewriteAllowed: false,
    apiWriteAttempted: false,
    privateEndpointUsed: false,
    approval: {
      required: true,
      decision: "pending",
      scope: "exact_source_and_body_sha256",
      tutorialId,
      sourceSha256,
      bodySha256,
      statement:
        "Approve only these exact source and editor-body hashes for a human-only DeFi Tutorials handoff.",
    },
  };
  const draft = {
    id: "draft:paper-trade",
    runId: RUN_ID,
    requestedAt: NOW,
    model: "openai/test",
    request: {
      kind: "tutorial",
      brief: "Explain paper trading before bounded authority.",
      channels: ["substack"],
      sourceUrls: [],
      tutorialId,
    },
    sourcePacket,
    tutorialHandoff,
    candidates: [{
      id: CANDIDATE_ID,
      channel: "substack",
      action: "prepare_tutorial",
      kind: "tutorial",
      topics: ["protocol", "simulation"],
      body: bodyMarkdown,
      links: ["https://www.0xzaps.com/virtual-trading"],
      disclosures: ["pre_audit"],
      claims: [{
        text: "Virtual Trading is wallet-free.",
        factKeys: ["virtual-trading"],
        treatment: "asserted",
      }],
      sourcePacket,
      interaction: null,
      flags: {
        containsCredential: false,
        guaranteesReturns: false,
        impersonatesPerson: false,
        requestsPolicyBypass: false,
        unsolicitedBulkMessaging: false,
        usesUnavailableAsZero: false,
      },
    }],
    presentations: [{
      candidateId: CANDIDATE_ID,
      channel: "substack",
      title: "Paper Trade First",
      tags: ["OpenZaps", "DeFi"],
    }],
    policy: [{
      policyVersion: 2,
      candidateId: CANDIDATE_ID,
      riskTier: 3,
      disposition: "require_approval",
      approvalRequired: true,
      approvalReasons: ["tutorial"],
      requiredDisclosures: ["pre_audit"],
      dailyCounter: "substackTutorials",
      issues: [],
      evaluatedAt: NOW,
    }],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
  return {
    runId: RUN_ID,
    status: "requires_human_publish",
    draft,
    approval: {
      decision: "approve",
      approvedBy: "authenticated-operator",
      tutorialApproval: {
        decision: "approve",
        approvedBy: "authenticated-operator",
        tutorialId,
        sourceSha256,
        bodySha256,
      },
    },
    deliveries: [{
      channel: "substack",
      candidateId: CANDIDATE_ID,
      status: "requires_human_publish",
      idempotencyKey: "handoff:paper-trade",
      editorUrl: "https://defitutorials.substack.com/publish/post",
    }],
  };
}

function verificationRequest(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    canonicalUrl: CANONICAL_URL,
    ...overrides,
  };
}

function request(
  body: unknown,
  token = "operator-token",
  headers?: HeadersInit,
): Request {
  return new Request(
    "https://www.0xzaps.com/api/marketing/substack/verify",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
  getRunMock.mockReturnValue({
    exists: Promise.resolve(true),
    status: Promise.resolve("completed"),
    returnValue: Promise.resolve(workflowResult()),
  });
  loadTutorialMock.mockReturnValue(workflowResult().draft.tutorialHandoff);
  verifyMock.mockResolvedValue({
    channel: "substack",
    status: "rss_confirmed",
    canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
    approvedTitle: "Paper Trade First",
    feedUrl: "https://defitutorials.substack.com/feed",
    checkedAt: "2026-08-01T02:00:00.000Z",
    publishedAt: "2026-08-01T01:00:00.000Z",
    persisted: false,
  });
  recordReceiptMock.mockResolvedValue({
    result: "recorded",
    tutorialId: "paper-trade-first-authority-map",
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
    sourceSha256: "a".repeat(64),
    bodySha256: "b".repeat(64),
    approvedTitle: "Paper Trade First",
    canonicalUrl: CANONICAL_URL,
    feedUrl: "https://defitutorials.substack.com/feed",
    publishedAt: "2026-08-01T01:00:00.000Z",
    rssCheckedAt: "2026-08-01T02:00:00.000Z",
    recordedAt: "2026-08-01T02:00:01.000Z",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Substack verification route", () => {
  it("authenticates before reading the request or public feed", async () => {
    const response = await POST(request("{", "wrong-token"));

    expect(response.status).toBe(401);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("bounds and strictly validates the request", async () => {
    const oversized = await POST(
      request(
        verificationRequest(),
        "operator-token",
        { "content-length": String(4 * 1_024 + 1) },
      ),
    );
    const extra = await POST(
      request({
        ...verificationRequest(),
        persistAnyway: true,
      }),
    );

    expect(oversized.status).toBe(413);
    expect(extra.status).toBe(400);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("derives the approved title from a completed recorded editor handoff", async () => {
    const response = await POST(request(verificationRequest()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      status: "rss_confirmed",
      persisted: true,
      receiptResult: "recorded",
      tutorialId: "paper-trade-first-authority-map",
      sourceSha256: "a".repeat(64),
      bodySha256: "b".repeat(64),
      manifestEntry: {
        id: "paper-trade-first-authority-map",
        title: "Paper Trade First",
        sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
        status: "rss_confirmed",
        canonicalUrl: CANONICAL_URL,
        publishedAt: "2026-08-01T01:00:00.000Z",
      },
    });
    expect(body.manifestPatch).toBe(
      JSON.stringify(body.manifestEntry, null, 2),
    );
    expect(getRunMock).toHaveBeenCalledWith(RUN_ID);
    expect(verifyMock).toHaveBeenCalledWith({
      canonicalUrl: CANONICAL_URL,
      approvedTitle: "Paper Trade First",
    });
    expect(recordReceiptMock).toHaveBeenCalledWith({
      tutorialId: "paper-trade-first-authority-map",
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
      sourceSha256: "a".repeat(64),
      bodySha256: "b".repeat(64),
      approvedTitle: "Paper Trade First",
      canonicalUrl: CANONICAL_URL,
      feedUrl: "https://defitutorials.substack.com/feed",
      publishedAt: "2026-08-01T01:00:00.000Z",
      rssCheckedAt: "2026-08-01T02:00:00.000Z",
    });
  });

  it("does not persist a receipt until the exact RSS title and URL are confirmed", async () => {
    verifyMock.mockResolvedValue({
      channel: "substack",
      status: "not_found",
      canonicalUrl: CANONICAL_URL,
      approvedTitle: "Paper Trade First",
      feedUrl: "https://defitutorials.substack.com/feed",
      checkedAt: "2026-08-01T02:00:00.000Z",
      persisted: false,
    });

    const response = await POST(request(verificationRequest()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "not_found",
      persisted: false,
    });
    expect(recordReceiptMock).not.toHaveBeenCalled();
  });

  it("fails closed when a different immutable receipt already exists", async () => {
    const { TutorialPublicationReceiptError } = await import(
      "@/lib/marketing/tutorial-publication-receipt-server"
    );
    recordReceiptMock.mockRejectedValue(
      new TutorialPublicationReceiptError(
        "conflict",
        "secret conflicting tuple detail",
      ),
    );

    const response = await POST(request(verificationRequest()));
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(raw).toContain("immutable publication receipt");
    expect(raw).not.toContain("secret conflicting tuple detail");
  });

  it("rejects RSS verification when the source bundle changed after approval", async () => {
    loadTutorialMock.mockReturnValue({
      ...workflowResult().draft.tutorialHandoff,
      bodySha256: "c".repeat(64),
    });

    const response = await POST(request(verificationRequest()));

    expect(response.status).toBe(409);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("rejects an incomplete run or a candidate without the approved handoff", async () => {
    getRunMock.mockReturnValueOnce({
      exists: Promise.resolve(true),
      status: Promise.resolve("running"),
    });
    const incomplete = await POST(request(verificationRequest()));

    const wrongCandidate = await POST(
      request(verificationRequest({ candidateId: "draft:other:substack" })),
    );

    expect(incomplete.status).toBe(409);
    expect(wrongCandidate.status).toBe(409);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("rejects a result that was not owner-approved", async () => {
    const result = workflowResult();
    result.approval.decision = "reject";
    result.status = "rejected";
    result.deliveries = [];
    getRunMock.mockReturnValue({
      exists: Promise.resolve(true),
      status: Promise.resolve("completed"),
      returnValue: Promise.resolve(result),
    });

    const response = await POST(request(verificationRequest()));

    expect(response.status).toBe(409);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("does not reflect provider errors and preserves a bounded retry hint", async () => {
    verifyMock.mockRejectedValue(
      new ChannelAdapterError(
        "substack",
        "rate-limited",
        "secret provider detail",
        { retryAfterMs: 1_500 },
      ),
    );

    const response = await POST(request(verificationRequest()));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(raw).toBe(
      '{"error":"The public DeFi Tutorials RSS could not be verified."}',
    );
    expect(raw).not.toContain("secret provider detail");
  });
});
