import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRunMock, verifyMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
  verifyMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ getRun: getRunMock }));

vi.mock("@/lib/marketing/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketing/channels")>();
  return { ...actual, verifySubstackPublication: verifyMock };
});

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
    },
    sourcePacket,
    candidates: [{
      id: CANDIDATE_ID,
      channel: "substack",
      action: "prepare_tutorial",
      kind: "tutorial",
      topics: ["protocol", "simulation"],
      body: [
        "Paper trade first, before granting an agent any onchain trigger.",
        "OpenZaps Virtual Trading uses read-only quotes and browser-local state, so a builder can inspect the route without connecting a wallet, approving a token, signing a message, or sending a transaction.",
        "That rehearsal is not a promise of execution or returns. OpenZaps remains pre-audit software; verify the exact policy, contracts, assets, limits, and recovery path before any live use.",
      ].join("\n\n"),
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

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      status: "rss_confirmed",
      persisted: false,
    });
    expect(getRunMock).toHaveBeenCalledWith(RUN_ID);
    expect(verifyMock).toHaveBeenCalledWith({
      canonicalUrl: CANONICAL_URL,
      approvedTitle: "Paper Trade First",
    });
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
