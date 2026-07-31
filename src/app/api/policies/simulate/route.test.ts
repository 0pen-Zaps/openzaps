import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PolicyRpcError } from "@/lib/policy-exact";

vi.mock("server-only", () => ({}));

const policyMocks = vi.hoisted(() => ({
  compileExactPolicy: vi.fn(),
}));

vi.mock("@/lib/policy-exact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/policy-exact")>();
  return {
    ...actual,
    compileExactPolicy: policyMocks.compileExactPolicy,
  };
});

import {
  GET,
  POST,
  acquireExactPolicySlot,
  exactPolicyApiEnabled,
  readExactPolicyBody,
} from "./route";

afterEach(() => {
  policyMocks.compileExactPolicy.mockReset();
  vi.unstubAllEnvs();
});

describe("chain-exact policy API operational gates", () => {
  it("defaults off in production until quota and a dedicated HTTPS RPC are configured", async () => {
    expect(exactPolicyApiEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(exactPolicyApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_API_ENABLED: "true",
    })).toBe(false);
    expect(exactPolicyApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_API_ENABLED: "true",
      OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED: "true",
    })).toBe(false);
    expect(exactPolicyApiEnabled({
      NODE_ENV: "production",
      OPENZAPS_EXACT_POLICY_API_ENABLED: "true",
      OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED: "true",
      OPENZAPS_EXACT_POLICY_RPC_URL: "https://rpc.example/v1/project",
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

  it("fails closed before quota or body work when the provider URL is invalid", async () => {
    const credential = "provider-password-must-not-escape";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_API_ENABLED", "true");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED", "true");
    vi.stubEnv(
      "OPENZAPS_EXACT_POLICY_RPC_URL",
      `http://provider:${credential}@rpc.example/v1/project`,
    );

    const response = await POST(new NextRequest("https://0xzaps.com/api/policies/simulate", {
      method: "POST",
      body: "{",
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(body).toMatchObject({ code: "PROVIDER_UNAVAILABLE", broadcast: false });
    expect(JSON.stringify(body)).not.toContain(credential);
    expect(GET().status).toBe(503);
    expect(policyMocks.compileExactPolicy).not.toHaveBeenCalled();
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
    vi.stubEnv("OPENZAPS_EXACT_POLICY_RPC_URL", "");
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

  it("redacts RPC credentials from required and nonessential provider failures", async () => {
    const credential = "provider-password-must-not-escape";
    const providerUrl = `https://provider:${credential}@rpc.example/v1/project?apiKey=${credential}`;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_API_ENABLED", "true");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_DURABLE_QUOTA_ENABLED", "true");
    vi.stubEnv("OPENZAPS_EXACT_POLICY_RPC_URL", providerUrl);

    policyMocks.compileExactPolicy.mockRejectedValueOnce(
      new PolicyRpcError(
        `Request to ${providerUrl} failed.`,
        "capture-head",
        `URL: ${providerUrl}`,
      ),
    );
    const requiredFailure = await POST(new NextRequest(
      "https://0xzaps.com/api/policies/simulate",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.78" },
        body: "{}",
      },
    ));
    const requiredBody = await requiredFailure.json();

    expect(requiredFailure.status).toBe(503);
    expect(requiredBody).toMatchObject({
      code: "RPC_FAILURE",
      rpcFailure: true,
      stage: "capture-head",
    });
    expect(requiredBody).not.toHaveProperty("detail");
    expect(JSON.stringify(requiredBody)).not.toContain(credential);

    policyMocks.compileExactPolicy.mockResolvedValueOnce({
      status: "warn",
      stressCases: [{
        id: "thin-input",
        status: "rpc-failure",
        rpcFailure: true,
        amountIn: 1n,
        error: `Request to ${providerUrl} failed.`,
      }],
    });
    const stressFailure = await POST(new NextRequest(
      "https://0xzaps.com/api/policies/simulate",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.79" },
        body: "{}",
      },
    ));
    const stressBody = await stressFailure.json();

    expect(stressFailure.status).toBe(200);
    expect(stressBody.stressCases[0]).toMatchObject({
      rpcFailure: true,
      amountIn: "1",
      error: "The RPC provider could not serve this stress quote; no output was synthesized.",
    });
    expect(JSON.stringify(stressBody)).not.toContain(credential);
  });
});
