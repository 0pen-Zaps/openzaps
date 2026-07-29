import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { RECIPES } from "@/lib/blocks";
import {
  POLICY_TEMPLATE_SCHEMA,
  policyTemplatePublishMessage,
  preparePolicyTemplate,
  stableStringify,
} from "@/lib/policy-templates";
import {
  decodePolicyTemplateCursor,
  encodePolicyTemplateCursor,
  listPolicyTemplates,
  policyTemplatePublishingEnabled,
  policyTemplateSubscriptionsEnabled,
  verifyPolicyTemplatePublisher,
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
    })).toBe(true);
    expect(policyTemplateSubscriptionsEnabled({ NODE_ENV: "test" })).toBe(true);
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
