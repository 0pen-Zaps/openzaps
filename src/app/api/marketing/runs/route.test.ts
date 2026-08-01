import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createReplySubjectMock,
  startMock,
  verifyReplyTargetMock,
  workflowMock,
} = vi.hoisted(() => ({
  createReplySubjectMock: vi.fn(),
  startMock: vi.fn(),
  verifyReplyTargetMock: vi.fn(),
  workflowMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow/api", () => ({
  start: startMock,
}));

vi.mock("@/lib/marketing/channels/x", () => ({
  verifyXReplyTarget: verifyReplyTargetMock,
}));

vi.mock("@/lib/marketing/x-compliance-server", () => ({
  createMarketingXReplySubject: createReplySubjectMock,
}));

vi.mock("@/workflows/marketing-agent", () => ({
  openZapsMarketingWorkflow: workflowMock,
}));

import { POST } from "./route";

const VALID_BODY = {
  kind: "product_update",
  brief: "Explain the verified bounded-authority release.",
  channels: ["x", "discord"],
};
const X_TARGET_URL = "https://x.com/community/status/123456789";
const X_INTERACTION_REFERENCE = "8".repeat(30);
const X_VERIFIED_TARGET = {
  postId: "123456789",
  targetUrl: X_TARGET_URL,
  authorId: "200",
  authenticatedAccountId: "100",
  trigger: "mention" as const,
  observedAt: "2026-08-01T12:00:00.000Z",
};

function request(body: unknown, token = "operator-token", headers?: HeadersInit): Request {
  return new Request("https://www.0xzaps.com/api/marketing/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
  vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
  vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "true");
  vi.stubEnv("OPENZAPS_MARKETING_AUTO_PUBLISH", "false");
  vi.stubEnv("OPENZAPS_X_AI_REPLY_APPROVED", "false");
  verifyReplyTargetMock.mockResolvedValue(X_VERIFIED_TARGET);
  createReplySubjectMock.mockResolvedValue({
    result: "created",
    interaction: {
      id: X_INTERACTION_REFERENCE,
      trigger: "mention",
      observedAt: X_VERIFIED_TARGET.observedAt,
    },
    expiresAt: "2026-08-02T12:00:00.000Z",
  });
  startMock.mockResolvedValue({ runId: "wrun_test_1" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing run creation route", () => {
  it("authenticates before parsing or starting work", async () => {
    const response = await POST(request("{", "wrong-token"));

    expect(response.status).toBe(401);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized request before workflow admission", async () => {
    const response = await POST(request(
      VALID_BODY,
      "operator-token",
      { "content-length": String(24 * 1_024 + 1) },
    ));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Draft request too large." });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("enforces the strict draft schema and reviewed source origins", async () => {
    const unknownField = await POST(request({ ...VALID_BODY, unexpected: true }));
    const duplicateChannel = await POST(request({
      ...VALID_BODY,
      channels: ["x", "x"],
    }));
    const externalSource = await POST(request({
      ...VALID_BODY,
      sourceUrls: ["https://attacker.example/prompt"],
    }));

    expect(unknownField.status).toBe(400);
    expect(duplicateChannel.status).toBe(400);
    expect(externalSource.status).toBe(400);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("refuses to start when drafting is disabled", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "false");

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(503);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("refuses live drafting before model work when the durable ledger is absent", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "false");

    const response = await POST(request(VALID_BODY));
    const body = await response.json() as {
      error: string;
      blockers: string[];
    };

    expect(response.status).toBe(503);
    expect(body.blockers).toContain(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
    expect(startMock).not.toHaveBeenCalled();
  });

  it("starts a validated request and returns only the run handle", async () => {
    const response = await POST(request({
      ...VALID_BODY,
      brief: "  Explain the verified bounded-authority release.  ",
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ runId: "wrun_test_1", status: "queued" });
    expect(startMock).toHaveBeenCalledWith(
      workflowMock,
      [{
        ...VALID_BODY,
        brief: "Explain the verified bounded-authority release.",
        sourceUrls: [],
      }],
    );
  });

  it("passes the exact source-controlled tutorial selection into Workflow", async () => {
    const response = await POST(request({
      kind: "tutorial",
      brief: "Prepare the reviewed source-controlled tutorial.",
      channels: ["substack"],
      tutorialId: "paper-trade-first-authority-map",
    }));

    expect(response.status).toBe(202);
    expect(startMock).toHaveBeenCalledWith(
      workflowMock,
      [{
        kind: "tutorial",
        brief: "Prepare the reviewed source-controlled tutorial.",
        channels: ["substack"],
        sourceUrls: [],
        tutorialId: "paper-trade-first-authority-map",
      }],
    );
    expect(verifyReplyTargetMock).not.toHaveBeenCalled();
    expect(createReplySubjectMock).not.toHaveBeenCalled();
  });

  it("verifies and vaults a raw X target before passing only an opaque reference into Workflow", async () => {
    const response = await POST(request({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionUrl: X_TARGET_URL,
    }));

    expect(response.status).toBe(202);
    expect(verifyReplyTargetMock).toHaveBeenCalledWith(X_TARGET_URL);
    expect(createReplySubjectMock).toHaveBeenCalledWith(X_VERIFIED_TARGET);
    expect(startMock).toHaveBeenCalledOnce();
    const workflowRequest = startMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(workflowRequest).toEqual({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      sourceUrls: [],
      interactionReference: X_INTERACTION_REFERENCE,
    });
    expect(workflowRequest).not.toHaveProperty("interactionUrl");
    expect(workflowRequest).not.toHaveProperty("postId");
    expect(workflowRequest).not.toHaveProperty("targetUrl");
    expect(workflowRequest).not.toHaveProperty("authorId");
    expect(workflowRequest).not.toHaveProperty("authenticatedAccountId");
    expect(JSON.stringify(workflowRequest)).not.toContain(X_TARGET_URL);
  });

  it("rejects a caller-supplied opaque X reference at the public API boundary", async () => {
    const response = await POST(request({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionReference: X_INTERACTION_REFERENCE,
    }));

    expect(response.status).toBe(400);
    expect(verifyReplyTargetMock).not.toHaveBeenCalled();
    expect(createReplySubjectMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("fails closed when the durable X subject vault is unavailable", async () => {
    createReplySubjectMock.mockRejectedValue(
      new Error("durable store secret: should-never-leak"),
    );

    const response = await POST(request({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionUrl: X_TARGET_URL,
    }));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toBe('{"error":"Marketing workflow could not be started."}');
    expect(raw).not.toContain("should-never-leak");
    expect(verifyReplyTargetMock).toHaveBeenCalledOnce();
    expect(createReplySubjectMock).toHaveBeenCalledOnce();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("fails closed when the durable X subject vault does not create a reference", async () => {
    createReplySubjectMock.mockResolvedValue({
      result: "compliance_hold",
      interaction: null,
      expiresAt: null,
    });

    const response = await POST(request({
      kind: "community_reply",
      brief: "Paraphrased question about bounded agent authority.",
      channels: ["x"],
      interactionUrl: X_TARGET_URL,
    }));

    expect(response.status).toBe(503);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("sanitizes workflow start failures", async () => {
    startMock.mockRejectedValue(new Error("provider secret: should-never-leak"));

    const response = await POST(request(VALID_BODY));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toBe('{"error":"Marketing workflow could not be started."}');
    expect(raw).not.toContain("should-never-leak");
  });
});
