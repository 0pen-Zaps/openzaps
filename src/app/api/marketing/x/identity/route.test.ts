import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelAdapterError } from "@/lib/marketing/channels/shared";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verifyIdentity: vi.fn(),
}));

vi.mock("@/lib/marketing/channels/x", () => ({
  verifyXAuthenticatedIdentity: mocks.verifyIdentity,
}));

import { GET } from "./route";

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/x/identity", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing X identity route", () => {
  it("requires the private operator token", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ error: "Unauthorized." });
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
  });

  it("returns only the verified public account identity", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyIdentity.mockResolvedValue({
      authenticatedAccountId: "123456789",
      authenticatedUsername: "0xzaps",
      observedAt: "2026-08-01T15:00:00.000Z",
    });

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      authenticatedAccountId: "123456789",
      authenticatedUsername: "0xzaps",
      observedAt: "2026-08-01T15:00:00.000Z",
    });
    expect(raw).not.toContain("operator-secret");
  });

  it("sanitizes provider and configuration failures", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyIdentity.mockRejectedValue(
      new Error("provider response included x-provider-secret"),
    );

    const response = await GET(request("operator-secret"));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(raw)).toEqual({
      error: "X identity could not be verified.",
    });
    expect(raw).not.toContain("x-provider-secret");
  });

  it("never maps an upstream X authorization failure to operator-token 401", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyIdentity.mockRejectedValue(
      new ChannelAdapterError(
        "x",
        "provider-error",
        "X request failed with status 401.",
        { status: 401 },
      ),
    );

    const response = await GET(request("operator-secret"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "X identity could not be verified.",
    });
  });

  it("preserves only a bounded provider retry window", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    mocks.verifyIdentity.mockRejectedValue(
      new ChannelAdapterError(
        "x",
        "rate-limited",
        "X is rate limiting requests.",
        { retryAfterMs: 1_500 },
      ),
    );

    const response = await GET(request("operator-secret"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });
});
