import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  classifyXMention,
  isXMentionContentHash,
  readXMentionAutomationConfig,
  renderXMentionReply,
  xMentionContentHash,
  X_MENTION_TEMPLATE_IDS,
  X_MENTION_TEMPLATE_REGISTRY_DIGEST,
  type XMentionForClassification,
} from "./x-mentions";

const NOW = Date.parse("2026-08-01T16:00:00.000Z");
const BASE: XMentionForClassification = {
  id: "1999999999999999999",
  authorId: "200",
  conversationId: "1999999999999999999",
  text: "@0xzaps /docs",
  createdAt: "2026-08-01T15:55:00.000Z",
  possiblySensitive: false,
  authorProtected: false,
  isWithheld: false,
  hasMedia: false,
  hasExternalLink: false,
  isRepost: false,
};
const OPTIONS = {
  authenticatedAccountId: "100",
  expectedUsername: "0xzaps",
  nowMs: NOW,
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("X mention automation", () => {
  it.each([
    ["@0xzaps /docs", "docs-v1"],
    ["@0xzaps where can I find the docs?", "docs-v1"],
    ["@0xzaps request a zap", "request-zap-v1"],
    ["@0xzaps how do I try virtual trading?", "virtual-trading-v1"],
    ["@0xzaps what can an agent change?", "agent-authority-v1"],
    ["@0xzaps what is OpenZaps?", "about-v1"],
  ])("admits only an exact reviewed prompt: %s", (text, expected) => {
    expect(classifyXMention({ ...BASE, text }, OPTIONS)).toEqual({
      classification: expected,
      eligibleForAutomaticReply: true,
      templateId: expected,
      reason: "exact_reviewed_template",
    });
  });

  it("keeps freeform, sensitive, linked, media, reposted, stale, and self content out of auto-replies", () => {
    const cases: XMentionForClassification[] = [
      { ...BASE, text: "@0xzaps can you design a complex vault strategy?" },
      { ...BASE, text: "@0xzaps is this audited?" },
      { ...BASE, hasExternalLink: true },
      { ...BASE, hasMedia: true },
      { ...BASE, isRepost: true },
      { ...BASE, authorProtected: true },
      { ...BASE, isWithheld: true },
      { ...BASE, createdAt: "2026-07-30T15:55:00.000Z" },
      { ...BASE, authorId: "100" },
    ];

    for (const mention of cases) {
      expect(
        classifyXMention(mention, OPTIONS).eligibleForAutomaticReply,
      ).toBe(false);
    }
  });

  it("recognizes opt-out without generating a public confirmation", () => {
    expect(
      classifyXMention({ ...BASE, text: "@0xzaps please do not reply" }, OPTIONS),
    ).toEqual({
      classification: "opt_out",
      eligibleForAutomaticReply: false,
      templateId: null,
      reason: "explicit_opt_out",
    });
    for (const mention of [
      { ...BASE, text: "@0xzaps stop", hasExternalLink: true },
      { ...BASE, text: "@0xzaps stop", hasMedia: true },
      {
        ...BASE,
        text: "@0xzaps stop",
        createdAt: "2026-07-20T15:55:00.000Z",
      },
    ]) {
      expect(classifyXMention(mention, OPTIONS).classification).toBe("opt_out");
    }
  });

  it("rejects lossy or provider-sensitive exact-command lookalikes", () => {
    for (const mention of [
      { ...BASE, text: "@0xzaps /docs привет" },
      { ...BASE, text: "@0xzaps /docs 🚨" },
      { ...BASE, text: "@0xzaps /docs $" },
      { ...BASE, text: "@0xzaps /docs @someone" },
      { ...BASE, text: "@0xzaps /docs\u200b" },
      { ...BASE, possiblySensitive: true },
    ]) {
      expect(classifyXMention(mention, OPTIONS).eligibleForAutomaticReply).toBe(
        false,
      );
    }
  });

  it("accepts 19-digit X object IDs and rejects 20-digit IDs", () => {
    expect(classifyXMention(BASE, OPTIONS).eligibleForAutomaticReply).toBe(true);
    for (const mention of [
      { ...BASE, id: "12345678901234567890" },
      { ...BASE, authorId: "12345678901234567890" },
      { ...BASE, conversationId: "12345678901234567890" },
    ]) {
      expect(classifyXMention(mention, OPTIONS)).toMatchObject({
        classification: "blocked_invalid",
        eligibleForAutomaticReply: false,
        reason: "invalid_metadata",
      });
    }
  });

  it("HMACs transient text without returning it and renders bounded opt-out templates", () => {
    const first = xMentionContentHash(BASE.text, "a".repeat(32));
    const second = xMentionContentHash(BASE.text, "b".repeat(32));
    expect(isXMentionContentHash(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain("docs");
    expect(X_MENTION_TEMPLATE_REGISTRY_DIGEST).toMatch(/^[0-9a-f]{64}$/u);

    for (const templateId of X_MENTION_TEMPLATE_IDS) {
      const body = renderXMentionReply(templateId);
      expect(Array.from(body).length).toBeLessThanOrEqual(280);
      expect(body).toContain("Reply @0xzaps stop to opt out.");
    }
  });

  it("fails closed unless ingestion, identity, database, hashing, and campaign approval are independently ready", () => {
    const env = {
      NODE_ENV: "production",
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
      X_USER_ACCESS_TOKEN: "user-token",
      OPENZAPS_X_MENTION_HASH_SECRET: "h".repeat(32),
      OPENZAPS_X_MENTION_INGEST_ENABLED: "true",
      OPENZAPS_X_COMMERCIAL_USE_APPROVED: "true",
      OPENZAPS_X_COMPLIANCE_READY: "true",
      OPENZAPS_X_AUTO_REPLY_ENABLED: "true",
      OPENZAPS_X_AUTO_RESPONSE_APPROVED: "true",
      OPENZAPS_X_AUTO_RESPONSE_APPROVAL_DIGEST:
        X_MENTION_TEMPLATE_REGISTRY_DIGEST,
      OPENZAPS_X_AUTO_REPLY_DAILY_CAP: "1",
    } as const;

    expect(readXMentionAutomationConfig(env)).toMatchObject({
      ingestReady: true,
      autoReplyReady: true,
      dailyCap: 1,
      blockers: [],
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_X_AUTO_RESPONSE_APPROVED: "false",
      }),
    ).toMatchObject({
      ingestReady: true,
      autoReplyReady: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_X_COMMERCIAL_USE_APPROVED: "false",
      }),
    ).toMatchObject({
      ingestReady: false,
      autoReplyReady: false,
      commercialUseApproved: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_X_COMPLIANCE_READY: "false",
      }),
    ).toMatchObject({
      ingestReady: false,
      autoReplyReady: false,
      complianceReady: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_X_AUTO_RESPONSE_APPROVAL_DIGEST: "0".repeat(64),
      }),
    ).toMatchObject({
      ingestReady: true,
      autoReplyReady: false,
      templateApprovalDigestValid: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_X_MENTION_HASH_SECRET: "short",
      }),
    ).toMatchObject({
      ingestReady: false,
      autoReplyReady: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_MARKETING_AUTO_PUBLISH: "invalid",
      }),
    ).toMatchObject({
      ingestReady: false,
      autoReplyReady: false,
    });
    expect(
      readXMentionAutomationConfig({
        ...env,
        OPENZAPS_MARKETING_DAILY_X_REPLY_CAP: "0",
      }),
    ).toMatchObject({
      ingestReady: true,
      autoReplyReady: false,
      dailyCap: 0,
    });
  });
});
