import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { approvalTokenMock, resumeMock } = vi.hoisted(() => ({
  approvalTokenMock: vi.fn((runId: string) => `approval:${runId}`),
  resumeMock: vi.fn(),
}));

vi.mock("@/workflows/marketing-agent", () => ({
  marketingApprovalHook: { resume: resumeMock },
  marketingApprovalToken: approvalTokenMock,
}));

import { POST } from "./route";

function request(
  body: unknown,
  token = "operator-token",
  headers?: HeadersInit,
): Request {
  return new Request("https://www.0xzaps.com/api/marketing/approvals", {
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
  vi.stubEnv("OPENZAPS_MARKETING_APPROVER_ID", "  nodar  ");
  resumeMock.mockResolvedValue({ runId: "wrun_review_1" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing approval route", () => {
  it("authenticates before reading or resuming a hook", async () => {
    const response = await POST(request("{", "wrong-token"));

    expect(response.status).toBe(401);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("bounds approval bodies before parsing", async () => {
    const response = await POST(request(
      { runId: "wrun_review_1", decision: "approve" },
      "operator-token",
      { "content-length": String(4 * 1_024 + 1) },
    ));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Approval request too large." });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed, ambiguous, and path-like approval requests", async () => {
    const malformed = await POST(request("{"));
    const extra = await POST(request({
      runId: "wrun_review_1",
      decision: "approve",
      overridePolicy: true,
    }));
    const pathLike = await POST(request({
      runId: "../other-run",
      decision: "approve",
    }));

    expect(malformed.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(pathLike.status).toBe(400);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("resumes a single decision with normalized operator metadata", async () => {
    const response = await POST(request({
      runId: "wrun_review_1",
      decision: "approve",
      comment: "  Sources verified.  ",
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "wrun_review_1",
      status: "approved",
    });
    expect(approvalTokenMock).toHaveBeenCalledWith("wrun_review_1");
    expect(resumeMock).toHaveBeenCalledWith("approval:wrun_review_1", {
      decision: "approve",
      approvedBy: "nodar",
      comment: "Sources verified.",
    });
  });

  it("classifies a duplicate or stale decision as a conflict", async () => {
    resumeMock.mockResolvedValue(false);

    const response = await POST(request({
      runId: "wrun_review_1",
      decision: "reject",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This draft is not awaiting approval or was already decided.",
    });
  });

  it("does not reflect hook or backend errors", async () => {
    resumeMock.mockRejectedValue(new Error("hook secret should-never-leak"));

    const response = await POST(request({
      runId: "wrun_review_1",
      decision: "approve",
    }));
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(raw).toBe(
      '{"error":"This draft is not awaiting approval or the decision was invalid."}',
    );
    expect(raw).not.toContain("should-never-leak");
  });
});
