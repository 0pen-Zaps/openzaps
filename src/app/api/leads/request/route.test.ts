import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  storeReady: vi.fn(),
  start: vi.fn(),
  workflow: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({
  start: mocks.start,
}));
vi.mock("@/lib/leads/notification-server", () => ({
  leadNotificationDeliveryConfigured: mocks.configured,
}));
vi.mock("@/workflows/lead-notification", () => ({
  openZapsLeadNotificationWorkflow: mocks.workflow,
}));
vi.mock("@/lib/leads/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/server")>()),
  probeLeadStoreReadiness: mocks.storeReady,
  submitLeadRequest: vi.fn(),
}));

import { submitLeadRequest } from "@/lib/leads/server";
import { GET, POST } from "./route";

const mockedSubmit = vi.mocked(submitLeadRequest);

const body = {
  persona: "agent_builder",
  name: "Nodar Janashia",
  email: "nodar@example.com",
  project: "OpenZaps",
  projectUrl: "https://www.0xzaps.com",
  workflow:
    "Execute one reviewed DeFi workflow after a bounded trigger without granting broad wallet authority.",
  protocolsAssets: "Uniswap v4, USDC",
  trigger: "A reviewed event is verified.",
  guardrails: "Cap spend and allow only reviewed contracts.",
  timeline: "within_30_days",
  consent: true,
  website: "",
};

function request(
  value: unknown = body,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://www.0xzaps.com/api/leads/request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://www.0xzaps.com",
      "sec-fetch-site": "same-origin",
      "x-vercel-forwarded-for": "203.0.113.72",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

function readinessRequest(): Request {
  return new Request("https://www.0xzaps.com/api/leads/request", {
    headers: { "x-vercel-forwarded-for": "203.0.113.73" },
  });
}

beforeEach(() => {
  mocks.configured.mockReturnValue(true);
  mocks.storeReady.mockResolvedValue(true);
  mocks.start.mockResolvedValue({ runId: "wrun_lead_notification_1" });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/leads/request", () => {
  it("reports only non-secret intake readiness and never caches it", async () => {
    const ready = await GET(readinessRequest());
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("private, no-store");
    expect(await ready.json()).toEqual({ ready: true });

    mocks.storeReady.mockResolvedValue(false);
    const unavailable = await GET(readinessRequest());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ready: false });
  });
});

describe("POST /api/leads/request", () => {
  it("returns a minimal acceptance without echoing contact data or score", async () => {
    mockedSubmit.mockResolvedValue("accepted");

    const response = await POST(request());
    const raw = await response.text();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({ accepted: true });
    expect(raw).not.toContain("nodar@example.com");
    expect(raw).not.toContain("qualification");
    expect(mockedSubmit).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(mocks.workflow);
  });

  it("keeps durable acceptance successful when advisory workflow start fails", async () => {
    mockedSubmit.mockResolvedValue("accepted");
    mocks.start.mockRejectedValue(new Error("workflow unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("does not attempt workflow start when notification delivery is not ready", async () => {
    mockedSubmit.mockResolvedValue("accepted");
    mocks.configured.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("silently accepts the honeypot without touching durable storage", async () => {
    const response = await POST(
      request({ ...body, website: "https://spam.example" }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects missing or cross-origin browser provenance before reading", async () => {
    for (const origin of ["", "https://attacker.example"]) {
      const response = await POST(
        request(body, {
          origin,
          "sec-fetch-site": origin ? "cross-site" : "same-origin",
        }),
      );
      expect(response.status).toBe(403);
      expect(mockedSubmit).not.toHaveBeenCalled();
    }
  });

  it("enforces JSON, strict schema, and the encoded body cap", async () => {
    expect(
      (await POST(request(body, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect(
      (await POST(request({ ...body, surprise: true }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(body, {
            "content-length": String(16 * 1_024 + 1),
          }),
        )
      ).status,
    ).toBe(413);
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("surfaces the durable quota without exposing its fingerprint", async () => {
    mockedSubmit.mockResolvedValue("quota_reached");

    const response = await POST(request());
    const raw = await response.text();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("86400");
    expect(JSON.parse(raw)).toEqual({
      accepted: false,
      error: "Please try again later.",
    });
    expect(raw).not.toContain("fingerprint");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("fails closed when durable storage is unavailable", async () => {
    mockedSubmit.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      accepted: false,
      error: "Lead intake is temporarily unavailable.",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
