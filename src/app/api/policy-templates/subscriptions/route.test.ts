import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  getPolicyTemplate: vi.fn(),
  getPolicyTemplateSubscriptionSnapshot: vi.fn(),
  policyRegistryConfigured: vi.fn(),
  setPolicyTemplateSubscription: vi.fn(),
  verifyPolicyTemplateSubscriber: vi.fn(),
  verifyPolicyTemplateSubscriberRead: vi.fn(),
}));

vi.mock("@/lib/policy-template-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policy-template-server")>()),
  ...serverMocks,
}));

import { POST } from "@/app/api/policy-templates/subscriptions/route";
import { PolicyTemplateSubscriptionAdmissionError } from "@/lib/policy-template-server";

const subscriber = "0x1563915e194D8CfBA1943570603F7606A3115508";
const subscriberKey = "00000000-0000-4000-8000-000000000001";
const contentHash = `0x${"44".repeat(32)}`;
const signature = `0x${"11".repeat(65)}`;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED", "");
  serverMocks.policyRegistryConfigured.mockReturnValue(true);
  serverMocks.getPolicyTemplate.mockResolvedValue({ contentHash });
  serverMocks.getPolicyTemplateSubscriptionSnapshot.mockResolvedValue({
    subscriber,
    version: 3,
    contentHashes: [contentHash],
  });
  serverMocks.verifyPolicyTemplateSubscriber.mockResolvedValue({
    subscriber,
    subscriberKey,
    signature,
    subscribed: true,
    expectedVersion: 3,
    expiresAt: 1_800_000_120,
  });
  serverMocks.verifyPolicyTemplateSubscriberRead.mockResolvedValue({
    subscriber,
    subscriberKey,
    signature,
    expiresAt: 1_800_000_120,
  });
  serverMocks.setPolicyTemplateSubscription.mockResolvedValue({
    version: 4,
    subscribed: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("policy template subscription route", () => {
  it("defaults wallet-bound subscription writes off in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED", "");
    vi.stubEnv("OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_DURABLE_QUOTA_ENABLED", "");

    const response = await POST(new NextRequest(
      "https://0xzaps.com/api/policy-templates/subscriptions",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.json()).toMatchObject({
      code: "SUBSCRIPTIONS_DISABLED",
    });
  });

  it("returns authoritative state only after a signed read admission", async () => {
    const response = await POST(subscriptionRequest({
      operation: "read",
      subscriber,
      subscriberSignature: signature,
      requestNonce: `0x${"ab".repeat(32)}`,
      expiresAt: 1_800_000_120,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(serverMocks.verifyPolicyTemplateSubscriberRead).toHaveBeenCalledOnce();
    expect(serverMocks.getPolicyTemplateSubscriptionSnapshot).toHaveBeenCalledWith(
      subscriber,
      subscriberKey,
    );
    expect(await response.json()).toEqual({
      subscriber,
      version: 3,
      contentHashes: [contentHash],
    });
  });

  it("atomically applies the signed expected version and returns the new version", async () => {
    const response = await POST(subscriptionRequest({
      operation: "set",
      subscriber,
      subscriberSignature: signature,
      contentHash,
      subscribed: true,
      expectedVersion: 3,
      expiresAt: 1_800_000_120,
    }));

    expect(response.status).toBe(200);
    expect(serverMocks.setPolicyTemplateSubscription).toHaveBeenCalledWith(
      subscriberKey,
      contentHash,
      true,
      3,
      1_800_000_120,
    );
    expect(await response.json()).toEqual({
      subscriber,
      contentHash,
      subscribed: true,
      version: 4,
    });
  });

  it("allows a signed unsubscribe after moderation hides the exact template", async () => {
    serverMocks.verifyPolicyTemplateSubscriber.mockResolvedValueOnce({
      subscriber,
      subscriberKey,
      signature,
      subscribed: false,
      expectedVersion: 3,
      expiresAt: 1_800_000_120,
    });
    serverMocks.setPolicyTemplateSubscription.mockResolvedValueOnce({
      version: 4,
      subscribed: false,
    });

    const response = await POST(subscriptionRequest({
      operation: "set",
      subscriber,
      subscriberSignature: signature,
      contentHash,
      subscribed: false,
      expectedVersion: 3,
      expiresAt: 1_800_000_120,
    }));

    expect(response.status).toBe(200);
    expect(serverMocks.getPolicyTemplate).not.toHaveBeenCalled();
    expect(serverMocks.setPolicyTemplateSubscription).toHaveBeenCalledWith(
      subscriberKey,
      contentHash,
      false,
      3,
      1_800_000_120,
    );
    expect(await response.json()).toEqual({
      subscriber,
      contentHash,
      subscribed: false,
      version: 4,
    });
  });

  it("uses typed admission errors while preserving database outages as 502", async () => {
    serverMocks.verifyPolicyTemplateSubscriber.mockRejectedValueOnce(
      new PolicyTemplateSubscriptionAdmissionError(
        "Subscription authorization has expired.",
        "SIGNATURE_EXPIRED",
      ),
    );
    const expired = await POST(subscriptionRequest({
      operation: "set",
      subscriber,
      subscriberSignature: signature,
      contentHash,
      subscribed: true,
      expectedVersion: 3,
      expiresAt: 1_800_000_120,
    }));
    expect(expired.status).toBe(422);
    expect(expired.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await expired.json()).toMatchObject({ code: "SIGNATURE_EXPIRED" });

    serverMocks.getPolicyTemplate.mockRejectedValueOnce(new Error("database unavailable"));
    const outage = await POST(subscriptionRequest({
      operation: "set",
      subscriber,
      subscriberSignature: signature,
      contentHash,
      subscribed: true,
      expectedVersion: 3,
      expiresAt: 1_800_000_120,
    }));
    expect(outage.status).toBe(502);
    expect(await outage.json()).toEqual({ error: "Policy subscription write failed." });
  });

  it("does not expose an unsigned address-to-subscription lookup", async () => {
    serverMocks.verifyPolicyTemplateSubscriberRead.mockRejectedValueOnce(
      new PolicyTemplateSubscriptionAdmissionError(
        "Subscriber signature must be a 65-byte wallet signature.",
        "INVALID_SIGNATURE",
      ),
    );
    const response = await POST(subscriptionRequest({
      operation: "read",
      subscriber,
      requestNonce: `0x${"ab".repeat(32)}`,
      expiresAt: 1_800_000_120,
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(serverMocks.getPolicyTemplateSubscriptionSnapshot).not.toHaveBeenCalled();
  });

  it("caps cumulative chunked bodies before parsing or signature admission", async () => {
    const response = await POST(streamedSubscriptionRequest([
      "{\"padding\":\"",
      "x".repeat(2_048),
      "\"}",
    ]));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Body too large." });
    expect(serverMocks.verifyPolicyTemplateSubscriber).not.toHaveBeenCalled();
    expect(serverMocks.verifyPolicyTemplateSubscriberRead).not.toHaveBeenCalled();
  });
});

function subscriptionRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://0xzaps.com/api/policy-templates/subscriptions", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.82" },
    body: JSON.stringify(body),
  });
}

function streamedSubscriptionRequest(chunks: string[]): NextRequest {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  return new NextRequest(new Request(
    "https://0xzaps.com/api/policy-templates/subscriptions",
    {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.83" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  ));
}
