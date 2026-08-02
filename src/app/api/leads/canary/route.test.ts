import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runCanary: vi.fn(),
  startWorkflow: vi.fn(),
  track: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leads/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/server")>()),
  runLeadIntakeRollbackCanary: mocks.runCanary,
}));
vi.mock("workflow/api", () => ({ start: mocks.startWorkflow }));
vi.mock("@vercel/analytics/server", () => ({ track: mocks.track }));

import { LeadStoreError } from "@/lib/leads/server";
import { POST } from "./route";

const TOKEN = "lead-desk-token-that-is-at-least-32-bytes";
const PASSED_CANARY = {
  result: "passed",
  transaction: "rolled_back",
  verified: {
    quota: true,
    lead: true,
    lifecycle: true,
    notificationOutbox: true,
  },
  persistentRows: 0,
  notificationDispatched: false,
} as const;

function request(
  token = TOKEN,
  options: Readonly<{ query?: string; body?: string }> = {},
): Request {
  return new Request(
    `https://www.0xzaps.com/api/leads/canary${options.query ?? ""}`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      body: options.body,
    },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/leads/canary", () => {
  it("requires the separately scoped lead-desk credential", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    const response = await POST(request("wrong-token"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(mocks.runCanary).not.toHaveBeenCalled();
  });

  it("rejects every caller-supplied query or body before the RPC", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    const queryResponse = await POST(request(TOKEN, { query: "?mode=test" }));
    const bodyResponse = await POST(request(TOKEN, {
      body: JSON.stringify({ email: "caller@example.com" }),
    }));

    expect(queryResponse.status).toBe(400);
    expect(bodyResponse.status).toBe(400);
    expect(await queryResponse.json()).toEqual({
      error: "The lead-intake canary accepts no input.",
    });
    expect(await bodyResponse.json()).toEqual({
      error: "The lead-intake canary accepts no input.",
    });
    expect(mocks.runCanary).not.toHaveBeenCalled();
  });

  it("returns only fixed rollback metadata and starts no external side effect", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    mocks.runCanary.mockResolvedValue(PASSED_CANARY);

    const response = await POST(request());
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({ canary: PASSED_CANARY });
    expect(raw).not.toMatch(/@|fingerprint|lead-intake-canary\+/iu);
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("fails closed without returning database details", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);
    mocks.runCanary.mockRejectedValue(
      new LeadStoreError(
        "rpc-error",
        "service-secret OPENZAPS_LEAD_INTAKE_CANARY_ASSERTION_FAILED",
        400,
      ),
    );

    const response = await POST(request());
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("Lead intake rollback could not be confirmed.");
    expect(raw).not.toContain("service-secret");
    expect(raw).not.toContain("ASSERTION_FAILED");
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
