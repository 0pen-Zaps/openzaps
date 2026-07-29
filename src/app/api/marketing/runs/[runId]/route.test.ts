import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRunMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getRun: getRunMock,
}));

import { GET } from "./route";

const NOW = "2026-07-29T12:00:00.000Z";

function request(token = "operator-token"): Request {
  return new Request("https://www.0xzaps.com/api/marketing/runs/wrun_review_1", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function context(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

function readable(events: unknown[]) {
  let index = 0;
  return {
    getTailIndex: vi.fn().mockResolvedValue(events.length - 1),
    getReader: () => ({
      read: vi.fn(async () => (
        index < events.length
          ? { done: false, value: events[index++] }
          : { done: true, value: undefined }
      )),
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function draftBundle() {
  const sourcePacket = {
    id: "source-1",
    createdAt: NOW,
    protocolPreAudit: true,
    facts: [{
      key: "release",
      label: "Release",
      value: "Verified",
      status: "confirmed",
      sourceUrl: "https://www.0xzaps.com/docs",
      observedAt: NOW,
    }],
    externalData: [],
    interaction: null,
  };
  return {
    id: "draft-1",
    runId: "wrun_review_1",
    requestedAt: NOW,
    model: "openai/test",
    request: {
      kind: "product_update",
      brief: "Explain the verified bounded-authority release.",
      channels: ["x"],
      sourceUrls: [],
    },
    sourcePacket,
    candidates: [{
      id: "candidate-1",
      channel: "x",
      action: "broadcast",
      kind: "product_update",
      topics: ["protocol"],
      body: "Verified bounded authority. Pre-audit software. Verify before use.",
      links: ["https://www.0xzaps.com/docs"],
      disclosures: ["pre_audit"],
      claims: [{
        text: "The release is verified.",
        factKeys: ["release"],
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
      candidateId: "candidate-1",
      channel: "x",
    }],
    policy: [{
      policyVersion: 1,
      candidateId: "candidate-1",
      riskTier: 1,
      disposition: "require_approval",
      approvalRequired: true,
      approvalReasons: ["auto_publish_disabled"],
      requiredDisclosures: ["pre_audit"],
      dailyCounter: "xPosts",
      issues: [],
      evaluatedAt: NOW,
    }],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing run status route", () => {
  it("authenticates and validates the run id before workflow lookup", async () => {
    const unauthorized = await GET(request("wrong-token"), context("wrun_review_1"));
    const invalid = await GET(request(), context("../another-run"));

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("returns not found without exposing workflow errors", async () => {
    getRunMock.mockReturnValue({ exists: Promise.resolve(false) });

    const response = await GET(request(), context("wrun_missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workflow run not found." });
  });

  it("keeps the draft visible when the latest event is an approval", async () => {
    const draft = draftBundle();
    const approval = {
      decision: "approve",
      approvedBy: "nodar",
      comment: "Sources verified.",
    };
    getRunMock.mockReturnValue({
      exists: Promise.resolve(true),
      status: Promise.resolve("running"),
      getReadable: vi.fn(() => readable([
        {
          type: "draft",
          at: NOW,
          state: "awaiting_approval",
          draft,
        },
        {
          type: "approval",
          at: NOW,
          state: "approved",
          approval,
        },
      ])),
    });

    const response = await GET(request(), context("wrun_review_1"));
    const body = await response.json() as {
      run: {
        status: string;
        draft?: { id: string };
        approval?: { decision: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body.run.status).toBe("approved");
    expect(body.run.draft?.id).toBe("draft-1");
    expect(body.run.approval).toMatchObject({ decision: "approve" });
  });

  it("lets a terminal workflow failure override a stale awaiting-approval event", async () => {
    const draft = draftBundle();
    getRunMock.mockReturnValue({
      exists: Promise.resolve(true),
      status: Promise.resolve("failed"),
      getReadable: vi.fn(() => readable([
        {
          type: "draft",
          at: NOW,
          state: "awaiting_approval",
          draft,
        },
      ])),
    });

    const response = await GET(request(), context("wrun_review_1"));
    const body = await response.json() as {
      run: { status: string; workflowStatus: string; draft?: { id: string } };
    };

    expect(response.status).toBe(200);
    expect(body.run).toMatchObject({
      status: "failed",
      workflowStatus: "failed",
      draft: { id: "draft-1" },
    });
  });
});
