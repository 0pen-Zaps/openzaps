import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  GET,
  POST,
  acquireExactPolicySlot,
  exactPolicyApiEnabled,
  readExactPolicyBody,
} from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chain-exact policy API operational gates", () => {
  it("defaults off in production until the durable WAF quota is enabled", async () => {
    expect(exactPolicyApiEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(exactPolicyApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_API_ENABLED: "true",
    })).toBe(false);
    expect(exactPolicyApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_API_ENABLED: "true",
      OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED: "true",
    })).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_API_ENABLED", "");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED", "");
    const response = await POST(new NextRequest("https://0xzaps.com/api/policies/simulate", {
      method: "POST",
      body: "{}",
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect((await response.json()).code).toBe("FEATURE_DISABLED");
    expect(GET().status).toBe(503);
  });

  it("rejects a raw body over 16 KiB before parsing JSON", async () => {
    const request = new NextRequest("https://0xzaps.com/api/policies/simulate", {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(16_384) }),
    });
    await expect(readExactPolicyBody(request)).rejects.toMatchObject({
      message: "Body too large.",
      status: 413,
    });
  });

  it("bounds warm-instance concurrency and releases a slot idempotently", () => {
    const releases = Array.from({ length: 4 }, () => acquireExactPolicySlot());
    expect(releases.every(Boolean)).toBe(true);
    expect(acquireExactPolicySlot()).toBeNull();
    releases[0]?.();
    releases[0]?.();
    const replacement = acquireExactPolicySlot();
    expect(replacement).not.toBeNull();
    replacement?.();
    for (const release of releases.slice(1)) release?.();
  });

  it("rate limits one warm-instance caller with Retry-After", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const responses = [];
    for (let index = 0; index < 7; index += 1) {
      responses.push(await POST(new NextRequest("https://0xzaps.com/api/policies/simulate", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.77" },
        body: "{",
      })));
    }
    expect(responses.slice(0, 6).every((response) => response.status === 400)).toBe(true);
    expect(responses[6].status).toBe(429);
    expect(responses[6].headers.get("retry-after")).toBe("60");
  });
});
