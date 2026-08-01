import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  hasSubstackEditorHandoff,
  LeadDeleteControls,
  leadDeleteTriggerId,
  leadOperationIsCurrent,
  leadReplyHref,
  operatorLeads,
  parseSubstackVerification,
  pollRetryDelay,
  readinessRows,
  shouldRetryPoll,
  SubstackHandoff,
  substackVerificationResponseIsCurrent,
  writeSubstackClipboard,
} from "./MarketingOperator";

const VALID_LEAD = {
  id: "019fab5e-be72-72d2-809b-0a1d4a35c86b",
  persona: "protocol_team",
  name: "Partner Builder",
  email: "partner@example.com",
  emailVerified: false,
  project: "Partner Protocol",
  projectUrl: "https://example.com",
  workflow: "Route a bounded protocol workflow with fixed authority.",
  protocolsAssets: "USDC, WETH",
  trigger: "A reviewed manual trigger",
  guardrails: "Fixed recipient, target, spend limit, and expiry",
  timeline: "within_30_days",
  attribution: { utmSource: "x" },
  qualificationScore: 5,
  status: "new",
  createdAt: "2026-07-30T02:00:00.000Z",
  updatedAt: "2026-07-30T02:00:00.000Z",
  expiresAt: "2027-01-26T02:00:00.000Z",
};

describe("operator lead queue parsing", () => {
  it("keeps a bounded operator lead and its verification state", () => {
    expect(operatorLeads({ leads: [VALID_LEAD] })).toEqual([VALID_LEAD]);
  });

  it("drops malformed entries and refuses oversized queues", () => {
    expect(
      operatorLeads({
        leads: [
          { ...VALID_LEAD, qualificationScore: 6 },
          { ...VALID_LEAD, emailVerified: "yes" },
          { ...VALID_LEAD, status: "emailed" },
        ],
      }),
    ).toEqual([]);

    expect(
      operatorLeads({ leads: Array.from({ length: 101 }, () => VALID_LEAD) }),
    ).toEqual([]);
  });
});

describe("operator follow-up helpers", () => {
  it("builds a fixed-purpose mail link without letting contact data alter its query", () => {
    expect(leadReplyHref("partner@example.com")).toBe(
      "mailto:partner%40example.com?subject=Your%20OpenZaps%20Zap%20request",
    );
    expect(leadReplyHref("partner@example.com?body=unexpected")).toBe(
      "mailto:partner%40example.com%3Fbody%3Dunexpected?subject=Your%20OpenZaps%20Zap%20request",
    );
  });

  it("backs off transient polling failures and caps the retry interval", () => {
    expect(pollRetryDelay(1)).toBe(2_500);
    expect(pollRetryDelay(2)).toBe(5_000);
    expect(pollRetryDelay(5)).toBe(30_000);
    expect(pollRetryDelay(50)).toBe(30_000);
  });

  it("retries only transient polling failures", () => {
    expect(shouldRetryPoll()).toBe(true);
    expect(shouldRetryPoll(408)).toBe(true);
    expect(shouldRetryPoll(429)).toBe(true);
    expect(shouldRetryPoll(503)).toBe(true);
    expect(shouldRetryPoll(400)).toBe(false);
    expect(shouldRetryPoll(401)).toBe(false);
    expect(shouldRetryPoll(404)).toBe(false);
  });

  it("invalidates an old lead mutation after forget, reconnect, or a newer action", () => {
    expect(
      leadOperationIsCurrent({
        expectedSessionGeneration: 4,
        expectedActionGeneration: 7,
        currentSessionGeneration: 4,
        currentActionGeneration: 7,
      }),
    ).toBe(true);
    expect(
      leadOperationIsCurrent({
        expectedSessionGeneration: 4,
        expectedActionGeneration: 7,
        currentSessionGeneration: 5,
        currentActionGeneration: 7,
      }),
    ).toBe(false);
    expect(
      leadOperationIsCurrent({
        expectedSessionGeneration: 4,
        expectedActionGeneration: 7,
        currentSessionGeneration: 4,
        currentActionGeneration: 8,
      }),
    ).toBe(false);
  });
});

describe("marketing readiness presentation", () => {
  it("distinguishes configured prerequisites from provider health and unsupported adapters", () => {
    const rows = readinessRows({
      config: {
        mode: "review_only",
        autoPublishRequested: true,
        autoPublish: false,
        xAiReplyApproved: false,
        dailyCaps: {
          xPosts: 1,
          xReplies: 2,
          discordPosts: 2,
          substackTutorials: 1,
          directMessages: 0,
        },
        readiness: {
          configurationValid: true,
          canDraft: true,
          durableLedgerConfigured: true,
          autoPublishReady: false,
          blockers: [],
          channels: {
            x: true,
            discordBroadcast: true,
            discordInteractions: true,
            directMessages: false,
            substackDirectPublish: false,
            substackManualHandoff: true,
            farcaster: false,
            github: false,
          },
        },
      },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get("mode")).toMatchObject({
      state: "review_only",
      ready: true,
    });
    expect(byKey.get("autoPublish")).toMatchObject({
      state: "gated",
      ready: false,
    });
    expect(byKey.get("x")?.detail).toContain(
      "Identity and write availability are rechecked before every post.",
    );
    expect(byKey.get("discordInteractions")?.detail).toContain(
      "does not prove a live command invocation",
    );
    expect(byKey.get("directMessages")).toMatchObject({
      state: "unsupported",
      ready: false,
    });
    expect(byKey.get("substackDirectPublish")?.detail).toContain(
      "official-editor human handoff",
    );
    expect(byKey.get("substackManualHandoff")).toMatchObject({
      state: "manual",
      ready: true,
    });
    expect(byKey.get("dailyCaps")?.detail).toContain("direct messages 0");
    expect(rows.map((row) => row.detail).join(" ")).not.toContain(
      "Configured and available.",
    );
    expect(rows.map((row) => row.detail).join(" ")).not.toContain(
      "Not configured.",
    );
  });
});

describe("lead deletion controls", () => {
  it("keeps a stable focus target while the permanent-delete confirmation expands", () => {
    const leadId = "lead with spaces/and-a-slash";
    const props = {
      leadId,
      busy: false,
      onToggle: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const triggerId = leadDeleteTriggerId(leadId);
    const collapsed = renderToStaticMarkup(
      createElement(LeadDeleteControls, { ...props, expanded: false }),
    );
    const expanded = renderToStaticMarkup(
      createElement(LeadDeleteControls, { ...props, expanded: true }),
    );

    expect(triggerId).not.toMatch(/\s/u);
    expect(collapsed).toContain(`id="${triggerId}"`);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("Confirm permanent delete");
    expect(expanded).toContain(`id="${triggerId}"`);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("Hide delete options");
    expect(expanded).toContain("Confirm permanent delete");
    expect(expanded).toContain('aria-label="Permanent deletion confirmation"');
  });
});

describe("Substack handoff helpers", () => {
  const expectedReceipt = {
    runId: "wrun_substack_1",
    candidateId: "draft:paper-trade:substack",
    canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
  };

  it("unlocks RSS verification only for the recorded official editor handoff", () => {
    expect(
      hasSubstackEditorHandoff({
        deliveries: [
          {
            channel: "substack",
            candidateId: expectedReceipt.candidateId,
            status: "requires_human_publish",
            editorUrl: "https://defitutorials.substack.com/publish/post",
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasSubstackEditorHandoff(
        {
          deliveries: [
            {
              channel: "substack",
              candidateId: expectedReceipt.candidateId,
              status: "requires_human_publish",
              editorUrl: "https://defitutorials.substack.com/publish/post",
            },
          ],
        },
        "draft:other:substack",
      ),
    ).toBe(false);
    expect(
      hasSubstackEditorHandoff({
        deliveries: [
          {
            channel: "substack",
            status: "published",
            editorUrl: "https://attacker.example/private-endpoint",
          },
        ],
      }),
    ).toBe(false);
  });

  it("accepts only a bounded non-persisted RSS verification receipt", () => {
    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        canonicalUrl: expectedReceipt.canonicalUrl,
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        publishedAt: "2026-08-01T01:00:00.000Z",
        persisted: false,
      }, expectedReceipt),
    ).toMatchObject({ status: "rss_confirmed", persisted: false });

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        canonicalUrl: expectedReceipt.canonicalUrl,
        approvedTitle: "Paper Trade First",
        feedUrl: "https://attacker.example/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        persisted: true,
      }, expectedReceipt),
    ).toBeNull();

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        candidateId: "draft:other:substack",
        status: "rss_confirmed",
        canonicalUrl: expectedReceipt.canonicalUrl,
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        persisted: false,
      }, expectedReceipt),
    ).toBeNull();

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        canonicalUrl: "https://defitutorials.substack.com/p/another-post",
        status: "rss_confirmed",
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        persisted: false,
      }, expectedReceipt),
    ).toBeNull();
  });

  it("rejects stale verification responses after the URL or request changes", () => {
    expect(
      substackVerificationResponseIsCurrent({
        requestGeneration: 2,
        currentGeneration: 2,
        requestedCanonicalUrl: expectedReceipt.canonicalUrl,
        currentRawUrl: `${expectedReceipt.canonicalUrl}/`,
      }),
    ).toBe(true);
    expect(
      substackVerificationResponseIsCurrent({
        requestGeneration: 1,
        currentGeneration: 2,
        requestedCanonicalUrl: expectedReceipt.canonicalUrl,
        currentRawUrl: expectedReceipt.canonicalUrl,
      }),
    ).toBe(false);
    expect(
      substackVerificationResponseIsCurrent({
        requestGeneration: 2,
        currentGeneration: 2,
        requestedCanonicalUrl: expectedReceipt.canonicalUrl,
        currentRawUrl: "https://defitutorials.substack.com/p/another-post",
      }),
    ).toBe(false);
  });

  it("falls back to plain text when rich clipboard MIME writing is rejected", async () => {
    const clipboard = {
      write: vi.fn().mockRejectedValue(new Error("HTML MIME unsupported")),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    const ClipboardItemCtor = class {} as unknown as typeof ClipboardItem;

    await expect(
      writeSubstackClipboard(
        { html: "<p>Paper trade first.</p>", plainText: "Paper trade first." },
        clipboard,
        ClipboardItemCtor,
      ),
    ).resolves.toBe("plain");
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith("Paper trade first.");
  });

  it("exposes editor handoff controls only after the exact candidate is approved", () => {
    const props = {
      candidateId: expectedReceipt.candidateId,
      value: {
        title: "Paper Trade First",
        bodyMarkdown: "## Start with zero authority\n\nReview the bounded policy.",
        tags: ["OpenZaps", "DeFi"],
      },
      operatorToken: "operator-test-token",
      runId: expectedReceipt.runId,
    };
    const awaitingApproval = renderToStaticMarkup(
      createElement(SubstackHandoff, {
        ...props,
        verificationEnabled: false,
      }),
    );
    expect(awaitingApproval).not.toContain("Copy rich text");
    expect(awaitingApproval).not.toContain("Open official editor");
    expect(awaitingApproval).not.toContain("Verify public RSS");
    expect(awaitingApproval).toContain(
      "Approve this exact draft before using the official editor handoff.",
    );

    const approvedHandoff = renderToStaticMarkup(
      createElement(SubstackHandoff, {
        ...props,
        verificationEnabled: true,
      }),
    );
    expect(approvedHandoff).toContain("Copy rich text");
    expect(approvedHandoff).toContain("Open official editor");
    expect(approvedHandoff).toContain("Verify public RSS");
  });
});
