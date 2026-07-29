import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startMock, workflowMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  workflowMock: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  start: startMock,
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

  it("sanitizes workflow start failures", async () => {
    startMock.mockRejectedValue(new Error("provider secret: should-never-leak"));

    const response = await POST(request(VALID_BODY));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toBe('{"error":"Marketing workflow could not be started."}');
    expect(raw).not.toContain("should-never-leak");
  });
});
