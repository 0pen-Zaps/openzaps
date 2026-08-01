import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMarketingSyndicationRepairProof,
  isMarketingAdminAuthorized,
  marketingAdminTokenConfigured,
  marketingAdminUnauthorizedResponse,
  verifyMarketingSyndicationRepairProof,
} from "@/lib/marketing/auth";

function request(authorization?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/status", {
    headers: authorization ? { authorization } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("marketing operator authorization", () => {
  it("fails closed when the admin token is absent or blank", () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "");
    expect(marketingAdminTokenConfigured()).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer anything"))).toBe(false);

    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "   ");
    expect(marketingAdminTokenConfigured()).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer anything"))).toBe(false);
  });

  it("accepts only an exact bearer token", () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "correct-horse-battery-staple");

    expect(marketingAdminTokenConfigured()).toBe(true);
    expect(isMarketingAdminAuthorized(request("Bearer correct-horse-battery-staple"))).toBe(true);
    expect(isMarketingAdminAuthorized(request("bearer correct-horse-battery-staple"))).toBe(true);
    expect(isMarketingAdminAuthorized(request("Bearer correct-horse-battery-stapler"))).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer short"))).toBe(false);
  });

  it("rejects missing, malformed, and ambiguous Authorization headers", () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");

    expect(isMarketingAdminAuthorized(request())).toBe(false);
    expect(isMarketingAdminAuthorized(request("Basic operator-token"))).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer"))).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer operator-token extra"))).toBe(false);
    expect(isMarketingAdminAuthorized(request("Bearer operator-token, Bearer other"))).toBe(false);
  });

  it("returns a generic non-cacheable challenge without exposing configuration", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "never-return-this-value");

    const response = marketingAdminUnauthorizedResponse();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="OpenZaps Marketing"');
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });

  it("binds a narrow repair proof to one exact item, run, and server secret", () => {
    const itemId = "ab".repeat(32);
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-repair-secret");
    const proof = createMarketingSyndicationRepairProof(itemId, "wrun_1");

    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifyMarketingSyndicationRepairProof(
      itemId,
      "wrun_1",
      proof as string,
    )).toBe(true);
    expect(verifyMarketingSyndicationRepairProof(
      itemId,
      "wrun_2",
      proof as string,
    )).toBe(false);
    expect(verifyMarketingSyndicationRepairProof(
      "cd".repeat(32),
      "wrun_1",
      proof as string,
    )).toBe(false);

    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "rotated-token");
    expect(verifyMarketingSyndicationRepairProof(
      itemId,
      "wrun_1",
      proof as string,
    )).toBe(true);

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "rotated-server-secret");
    expect(verifyMarketingSyndicationRepairProof(
      itemId,
      "wrun_1",
      proof as string,
    )).toBe(false);
  });
});
