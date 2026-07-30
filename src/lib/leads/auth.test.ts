import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLeadAdminAuthorized,
  leadAdminTokenConfigured,
  leadAdminUnauthorizedResponse,
} from "@/lib/leads/auth";

function request(authorization?: string): Request {
  return new Request("https://www.0xzaps.com/api/leads", {
    headers: authorization ? { authorization } : undefined,
  });
}

const TOKEN = "lead-desk-token-that-is-at-least-32-bytes";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lead desk authorization", () => {
  it("fails closed when the lead token is absent or blank", () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", "");
    expect(leadAdminTokenConfigured()).toBe(false);
    expect(isLeadAdminAuthorized(request("Bearer anything"))).toBe(false);

    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", "   ");
    expect(leadAdminTokenConfigured()).toBe(false);
    expect(isLeadAdminAuthorized(request("Bearer anything"))).toBe(false);
  });

  it("accepts only the exact lead bearer token", () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    expect(leadAdminTokenConfigured()).toBe(true);
    expect(isLeadAdminAuthorized(request(`Bearer ${TOKEN}`))).toBe(true);
    expect(isLeadAdminAuthorized(request(`bearer ${TOKEN}`))).toBe(true);
    expect(isLeadAdminAuthorized(request("Bearer marketing-token"))).toBe(false);
  });

  it("rejects malformed or ambiguous authorization", () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", TOKEN);

    expect(isLeadAdminAuthorized(request())).toBe(false);
    expect(isLeadAdminAuthorized(request(`Basic ${TOKEN}`))).toBe(false);
    expect(isLeadAdminAuthorized(request(`Bearer ${TOKEN} extra`))).toBe(false);
    expect(
      isLeadAdminAuthorized(
        request(`Bearer ${TOKEN}, Bearer marketing-token`),
      ),
    ).toBe(false);
  });

  it("returns a generic private challenge", async () => {
    const response = leadAdminUnauthorizedResponse();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="OpenZaps Lead Desk"',
    );
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });
});
