import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { RECIPES } from "@/lib/blocks";
import {
  POLICY_TEMPLATE_SCHEMA,
  policyTemplatePublishMessage,
  policyTemplateSubscriptionReadMessage,
  policyTemplateSubscriptionMessage,
  preparePolicyTemplate,
  stableStringify,
} from "@/lib/policy-templates";
import {
  decodePolicyTemplateCursor,
  encodePolicyTemplateCursor,
  getPolicyTemplateSubscriptionSnapshot,
  listPolicyTemplates,
  policyTemplatePublishingEnabled,
  policyTemplateSubscriptionsEnabled,
  PolicyTemplateSubscriptionAdmissionError,
  setPolicyTemplateSubscription,
  subscriberKeyForAddress,
  verifyPolicyTemplatePublisher,
  verifyPolicyTemplateSubscriber,
  verifyPolicyTemplateSubscriberRead,
} from "@/lib/policy-template-server";

const chain = RECIPES[0].blocks.map(([block, params]) => ({ block, params: params ?? {} }));

describe("public policy template content addressing", () => {
  it("is deterministic across object key order", () => {
    const left = preparePolicyTemplate({
      name: "Bounded buy",
      summary: "One reviewed route.",
      version: 1,
      parentHash: null,
      chain,
    });
    const right = preparePolicyTemplate({
      chain: chain.map((entry) => ({ params: { ...entry.params }, block: entry.block })),
      parentHash: null,
      version: 1,
      summary: "One reviewed route.",
      name: "Bounded buy",
    });
    expect(left.contentHash).toBe(right.contentHash);
    expect(left.schema).toBe(POLICY_TEMPLATE_SCHEMA);
  });

  it("makes metadata and exact lineage part of the immutable address", () => {
    const root = preparePolicyTemplate({ name: "Root", summary: "", version: 1, chain });
    const renamed = preparePolicyTemplate({ name: "Renamed", summary: "", version: 1, chain });
    const fork = preparePolicyTemplate({
      name: "Root",
      summary: "",
      version: 2,
      parentHash: root.contentHash,
      chain,
    });
    expect(renamed.contentHash).not.toBe(root.contentHash);
    expect(fork.contentHash).not.toBe(root.contentHash);
    expect(fork.parentHash).toBe(root.contentHash);
  });

  it("rejects invalid roots and blocked chains", () => {
    expect(() => preparePolicyTemplate({ name: "Bad", summary: "", version: 2, chain })).toThrow(/version 1/);
    expect(() =>
      preparePolicyTemplate({
        name: "Bad chain",
        summary: "",
        version: 1,
        chain: [
          { block: "wallet-balance", params: {} },
          { block: "wallet-balance", params: {} },
        ],
      }),
    ).toThrow(/does not compile/i);
  });

  it("sorts nested records before hashing", () => {
    expect(stableStringify({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it("admits only the wallet that signed the exact immutable content hash", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const prepared = preparePolicyTemplate({ name: "Signed", summary: "", version: 1, chain });
    const signature = await account.signMessage({ message: policyTemplatePublishMessage(prepared) });
    await expect(verifyPolicyTemplatePublisher(prepared, account.address, signature)).resolves.toMatchObject({
      publisher: account.address,
      signature,
    });

    const changed = preparePolicyTemplate({ name: "Changed", summary: "", version: 1, chain });
    await expect(verifyPolicyTemplatePublisher(changed, account.address, signature)).rejects.toThrow(
      "does not match",
    );
  });

  it("defaults production publishing off", () => {
    expect(policyTemplatePublishingEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(policyTemplatePublishingEnabled({
      NODE_ENV: "production",
      OPENZAPS_POLICY_TEMPLATE_PUBLISHING_ENABLED: "true",
    })).toBe(true);
    expect(policyTemplatePublishingEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("defaults production subscription writes off", () => {
    expect(policyTemplateSubscriptionsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(policyTemplateSubscriptionsEnabled({
      NODE_ENV: "production",
      OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED: "true",
    })).toBe(false);
    expect(policyTemplateSubscriptionsEnabled({
      NODE_ENV: "production",
      OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED: "true",
      OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_DURABLE_QUOTA_ENABLED: "true",
    })).toBe(true);
    expect(policyTemplateSubscriptionsEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("binds exact-version subscription state to one deterministic wallet pseudonym", async () => {
    const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const prepared = preparePolicyTemplate({ name: "Pinned", summary: "", version: 1, chain });
    const expectedVersion = 7;
    const now = 1_800_000_000;
    const expiresAt = now + 120;
    const message = policyTemplateSubscriptionMessage({
      subscriber: account.address,
      contentHash: prepared.contentHash,
      subscribed: true,
      expectedVersion,
      expiresAt,
    });
    const signature = await account.signMessage({ message });
    const admission = await verifyPolicyTemplateSubscriber(
      account.address,
      prepared.contentHash,
      true,
      expectedVersion,
      expiresAt,
      signature,
      now,
    );
    expect(admission).toMatchObject({
      subscriber: account.address,
      subscriberKey: subscriberKeyForAddress(account.address),
      signature,
      expectedVersion,
      expiresAt,
    });
    await expect(
      verifyPolicyTemplateSubscriber(
        account.address,
        prepared.contentHash,
        false,
        expectedVersion,
        expiresAt,
        signature,
        now,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
    await expect(
      verifyPolicyTemplateSubscriber(
        account.address,
        prepared.contentHash,
        true,
        expectedVersion + 1,
        expiresAt,
        signature,
        now,
      ),
    ).rejects.toThrow("does not match");
  });

  it("expires subscription authorizations quickly and rejects long-lived signatures", async () => {
    const account = privateKeyToAccount(`0x${"23".repeat(32)}`);
    const prepared = preparePolicyTemplate({ name: "Expiring", summary: "", version: 1, chain });
    const now = 1_800_000_000;
    const expiresAt = now + 120;
    const signature = await account.signMessage({
      message: policyTemplateSubscriptionMessage({
        subscriber: account.address,
        contentHash: prepared.contentHash,
        subscribed: true,
        expectedVersion: 0,
        expiresAt,
      }),
    });

    await expect(
      verifyPolicyTemplateSubscriber(
        account.address,
        prepared.contentHash,
        true,
        0,
        expiresAt,
        signature,
        expiresAt,
      ),
    ).rejects.toMatchObject({
      code: "SIGNATURE_EXPIRED",
      status: 422,
    } satisfies Partial<PolicyTemplateSubscriptionAdmissionError>);
    await expect(
      verifyPolicyTemplateSubscriber(
        account.address,
        prepared.contentHash,
        true,
        0,
        now + 301,
        signature,
        now,
      ),
    ).rejects.toMatchObject({
      code: "EXPIRY_TOO_FAR",
      status: 422,
    } satisfies Partial<PolicyTemplateSubscriptionAdmissionError>);
  });

  it("requires a separate short-lived wallet proof for private subscription reads", async () => {
    const account = privateKeyToAccount(`0x${"24".repeat(32)}`);
    const requestNonce = `0x${"ab".repeat(32)}`;
    const now = 1_800_000_000;
    const expiresAt = now + 90;
    const signature = await account.signMessage({
      message: policyTemplateSubscriptionReadMessage({
        subscriber: account.address,
        requestNonce,
        expiresAt,
      }),
    });

    await expect(
      verifyPolicyTemplateSubscriberRead(
        account.address,
        requestNonce,
        expiresAt,
        signature,
        now,
      ),
    ).resolves.toMatchObject({
      subscriber: account.address,
      subscriberKey: subscriberKeyForAddress(account.address),
      expiresAt,
    });
    await expect(
      verifyPolicyTemplateSubscriberRead(
        account.address,
        `0x${"cd".repeat(32)}`,
        expiresAt,
        signature,
        now,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
  });

  it("maps atomic database outcomes to typed replay and quota errors", async () => {
    const originalFetch = globalThis.fetch;
    const key = "00000000-0000-4000-8000-000000000001";
    const hash = `0x${"45".repeat(32)}`;
    try {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(Response.json([{
          result_code: "applied",
          resulting_version: "4",
          resulting_subscribed: true,
        }]))
        .mockResolvedValueOnce(Response.json([{
          result_code: "version_conflict",
          resulting_version: "4",
          resulting_subscribed: true,
        }]))
        .mockResolvedValueOnce(Response.json([{
          result_code: "subscriber_limit",
          resulting_version: "4",
          resulting_subscribed: false,
        }])) as typeof fetch;

      await expect(
        setPolicyTemplateSubscription(key, hash, true, 3, 1_800_000_120),
      ).resolves.toEqual({ version: 4, subscribed: true });
      await expect(
        setPolicyTemplateSubscription(key, hash, false, 3, 1_800_000_120),
      ).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
        status: 409,
        currentVersion: 4,
      } satisfies Partial<PolicyTemplateSubscriptionAdmissionError>);
      await expect(
        setPolicyTemplateSubscription(key, hash, true, 4, 1_800_000_120),
      ).rejects.toMatchObject({
        code: "SUBSCRIBER_LIMIT",
        status: 429,
      } satisfies Partial<PolicyTemplateSubscriptionAdmissionError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads a version and active exact hashes from service-role-only tables", async () => {
    const originalFetch = globalThis.fetch;
    const account = privateKeyToAccount(`0x${"25".repeat(32)}`);
    const key = subscriberKeyForAddress(account.address);
    const first = `0x${"45".repeat(32)}`;
    const second = `0x${"46".repeat(32)}`;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(Response.json([{
      resulting_version: "9",
      content_hashes: [first, second],
    }])) as typeof fetch;
    try {
      await expect(
        getPolicyTemplateSubscriptionSnapshot(account.address, key),
      ).resolves.toEqual({
        subscriber: account.address,
        version: 9,
        contentHashes: [first, second],
      });
      const calls = vi.mocked(globalThis.fetch).mock.calls;
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain("rpc/get_policy_template_subscription_snapshot");
      expect(calls[0][1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ p_subscriber_key: key }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("round-trips a deterministic immutable keyset cursor", () => {
    const cursor = {
      createdAt: "2026-07-28T22:00:00.000Z",
      contentHash: `0x${"12".repeat(32)}`,
    };
    expect(decodePolicyTemplateCursor(encodePolicyTemplateCursor(cursor))).toEqual(cursor);
    expect(() => decodePolicyTemplateCursor("not-a-cursor")).toThrow("Invalid policy registry cursor");
  });

  it("lists only approved visible publishers in stable oldest-first pages", async () => {
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return Response.json([]);
    }) as typeof fetch;
    try {
      await expect(listPolicyTemplates(24)).resolves.toEqual({ templates: [], nextCursor: null });
      const url = new URL(requested, "https://local.invalid");
      expect(url.searchParams.get("publisher_verified")).toBe("eq.true");
      expect(url.searchParams.get("visible")).toBe("eq.true");
      expect(url.searchParams.get("moderation_status")).toBe("eq.approved");
      expect(url.searchParams.get("order")).toBe("created_at.asc,content_hash.asc");
      expect(url.searchParams.get("limit")).toBe("25");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
