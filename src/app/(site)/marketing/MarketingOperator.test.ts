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
  operatorSyndicationItems,
  operatorResetClearsSyndicationRepair,
  parseSyndicationRepairPair,
  parseSubstackVerification,
  parseXIdentityVerification,
  pollRetryDelay,
  readinessRows,
  shouldRetryPoll,
  sourceControlledTutorialSelections,
  syndicationDeferredCount,
  syndicationItemCanDraft,
  syndicationRepairMatchesItem,
  syndicationNoticeAfterReconciliation,
  syndicationSkipTriggerId,
  SyndicationSkipControls,
  SubstackHandoff,
  substackVerificationResponseIsCurrent,
  tutorialApprovalEchoFromDraft,
  type OperatorSyndicationItem,
  writeSubstackClipboard,
  xIdentityRequestIsCurrent,
} from "./MarketingOperator";

describe("X identity evidence parsing", () => {
  it("accepts only a bounded public identity proof", () => {
    expect(
      parseXIdentityVerification({
        authenticatedAccountId: "123456789",
        authenticatedUsername: "0xzaps",
        observedAt: "2026-08-01T15:00:00.000Z",
      }),
    ).toEqual({
      authenticatedAccountId: "123456789",
      authenticatedUsername: "0xzaps",
      observedAt: "2026-08-01T15:00:00.000Z",
    });
  });

  it("rejects malformed or oversized provider data", () => {
    const valid = {
      authenticatedAccountId: "123456789",
      authenticatedUsername: "0xzaps",
      observedAt: "2026-08-01T15:00:00.000Z",
    };

    expect(parseXIdentityVerification([])).toBeNull();
    expect(
      parseXIdentityVerification({
        ...valid,
        authenticatedAccountId: "1".repeat(31),
      }),
    ).toBeNull();
    expect(
      parseXIdentityVerification({ ...valid, authenticatedAccountId: "abc" }),
    ).toBeNull();
    expect(
      parseXIdentityVerification({
        ...valid,
        authenticatedUsername: "x".repeat(16),
      }),
    ).toBeNull();
    expect(
      parseXIdentityVerification({ ...valid, observedAt: "not-a-date" }),
    ).toBeNull();
    expect(
      parseXIdentityVerification({
        authenticatedAccountId: valid.authenticatedAccountId,
        authenticatedUsername: valid.authenticatedUsername,
      }),
    ).toBeNull();
  });
});

describe("X identity request lifecycle", () => {
  it("rejects a response after either refresh or session invalidation", () => {
    expect(
      xIdentityRequestIsCurrent({
        requestGeneration: 3,
        currentRequestGeneration: 3,
        sessionGeneration: 5,
        currentSessionGeneration: 5,
      }),
    ).toBe(true);
    expect(
      xIdentityRequestIsCurrent({
        requestGeneration: 3,
        currentRequestGeneration: 4,
        sessionGeneration: 5,
        currentSessionGeneration: 5,
      }),
    ).toBe(false);
    expect(
      xIdentityRequestIsCurrent({
        requestGeneration: 3,
        currentRequestGeneration: 3,
        sessionGeneration: 5,
        currentSessionGeneration: 6,
      }),
    ).toBe(false);
  });
});

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

describe("operator syndication inbox parsing", () => {
  const VALID_ITEM = {
    itemId: "ab".repeat(32),
    source: "defitutorials",
    title: "Give an Agent the Trigger, Never the Authority",
    canonicalUrl:
      "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the",
    publishedAt: "2026-07-29T16:55:32.000Z",
    classification: "reviewable",
    status: "pending",
    campaignSlug: "give-an-agent-the-trigger-never-the-authority",
    workflowRunId: null,
    discoveredAt: "2026-08-01T04:00:00.000Z",
    updatedAt: "2026-08-01T04:00:00.000Z",
  } satisfies OperatorSyndicationItem;

  it("keeps only bounded, canonical syndication items", () => {
    expect(operatorSyndicationItems({ items: [VALID_ITEM] })).toEqual([
      VALID_ITEM,
    ]);
    expect(
      operatorSyndicationItems({
        items: [
          { ...VALID_ITEM, canonicalUrl: "https://example.com/post" },
          { ...VALID_ITEM, status: "ready_to_spam" },
          { ...VALID_ITEM, workflowRunId: "" },
        ],
      }),
    ).toEqual([]);

    expect(operatorSyndicationItems({
      items: [{
        ...VALID_ITEM,
        status: "drafting",
        workflowRunId: "wrun_syndication_1",
      }],
    })).toHaveLength(1);
    expect(operatorSyndicationItems({
      items: [{
        ...VALID_ITEM,
        status: "pending",
        workflowRunId: "wrun_syndication_1",
      }],
    })).toEqual([]);
    expect(operatorSyndicationItems({
      items: [{ ...VALID_ITEM, title: "x".repeat(201) }],
    })).toEqual([]);
    expect(operatorSyndicationItems({
      items: [{ ...VALID_ITEM, campaignSlug: `a${"b".repeat(96)}` }],
    })).toEqual([]);
  });

  it("refuses oversized inbox payloads", () => {
    expect(
      operatorSyndicationItems({
        items: Array.from({ length: 21 }, () => VALID_ITEM),
      }),
    ).toEqual([]);
  });

  it("accepts only a strict, bounded workflow repair pair", () => {
    const repair = {
      itemId: VALID_ITEM.itemId,
      runId: "wrun_original_1",
      repairProof: "a".repeat(43),
    };
    expect(parseSyndicationRepairPair(JSON.stringify(repair))).toEqual(repair);
    expect(parseSyndicationRepairPair(JSON.stringify({ ...repair, extra: true })))
      .toBeNull();
    expect(parseSyndicationRepairPair(JSON.stringify({
      ...repair,
      itemId: "not-an-item",
    }))).toBeNull();
    expect(parseSyndicationRepairPair(JSON.stringify({
      ...repair,
      runId: "bad/run",
    }))).toBeNull();
    expect(parseSyndicationRepairPair("x".repeat(401))).toBeNull();
  });

  it("offers repair only for the exact unlinked drafting item", () => {
    const drafting = {
      ...VALID_ITEM,
      status: "drafting" as const,
    };
    const repair = {
      itemId: VALID_ITEM.itemId,
      runId: "wrun_original_1",
      repairProof: "a".repeat(43),
    };
    expect(syndicationRepairMatchesItem(drafting, repair)).toBe(true);
    expect(syndicationRepairMatchesItem(
      { ...drafting, workflowRunId: repair.runId },
      repair,
    )).toBe(false);
    expect(syndicationRepairMatchesItem(
      { ...drafting, itemId: "cd".repeat(32) },
      repair,
    )).toBe(false);
  });

  it("preserves an exact repair proof across bearer rotation but clears it on explicit forget", () => {
    expect(operatorResetClearsSyndicationRepair("auth_rejected")).toBe(false);
    expect(operatorResetClearsSyndicationRepair("explicit_forget")).toBe(true);
  });

  it("surfaces only bounded deferred reconciliation counts", () => {
    expect(syndicationDeferredCount({ reconciliation: { deferred: 2 } })).toBe(2);
    expect(syndicationDeferredCount({ reconciliation: { deferred: 21 } })).toBe(0);
    expect(syndicationDeferredCount({ reconciliation: { deferred: "2" } })).toBe(0);
  });

  it("refreshes stale reconciliation warnings without clobbering action notices", () => {
    const warning = syndicationNoticeAfterReconciliation("", 2);
    expect(warning).toContain("2 attached workflows could not be reconciled");
    expect(syndicationNoticeAfterReconciliation(warning, 0)).toBe("");
    expect(syndicationNoticeAfterReconciliation(
      "Review draft started for X and Discord. Nothing has been published.",
      0,
    )).toBe(
      "Review draft started for X and Discord. Nothing has been published.",
    );
  });

  it("refuses a claim before an exact attributed X URL consumes its copy budget", () => {
    expect(syndicationItemCanDraft(VALID_ITEM)).toBe(true);
    expect(syndicationItemCanDraft({
      ...VALID_ITEM,
      canonicalUrl:
        `https://defitutorials.substack.com/p/${"a".repeat(120)}`,
      campaignSlug: `defitutorials-${"b".repeat(80)}`,
    })).toBe(false);
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

describe("syndication skip controls", () => {
  it("requires an explicit permanent-skip confirmation", () => {
    const itemId = "ab".repeat(32);
    const props = {
      itemId,
      busy: false,
      submitting: false,
      onToggle: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const triggerId = syndicationSkipTriggerId(itemId);
    const collapsed = renderToStaticMarkup(
      createElement(SyndicationSkipControls, { ...props, expanded: false }),
    );
    const expanded = renderToStaticMarkup(
      createElement(SyndicationSkipControls, { ...props, expanded: true }),
    );

    expect(collapsed).toContain(`id="${triggerId}"`);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("Confirm permanent skip");
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("Hide skip options");
    expect(expanded).toContain("Confirm permanent skip");
    expect(expanded).toContain(
      'aria-label="Permanent syndication skip confirmation"',
    );
  });
});

describe("Substack handoff helpers", () => {
  const expectedReceipt = {
    runId: "wrun_substack_1",
    candidateId: "draft:paper-trade:substack",
    canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
  };

  it("accepts only bounded byte-verified tutorial selectors and approval echoes", () => {
    const sourceSha256 = "a".repeat(64);
    const bodySha256 = "b".repeat(64);
    expect(sourceControlledTutorialSelections([{
      tutorialId: "paper-trade-first-authority-map",
      title: "Paper Trade First",
      manifestStatus: "draft",
      sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
      sourceSha256,
      bodySha256,
    }, {
      tutorialId: "paper-trade-first-authority-map",
      title: "Duplicate",
      manifestStatus: "draft",
      sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
      sourceSha256,
      bodySha256,
    }])).toHaveLength(1);

    const handoff = {
      tutorialHandoff: {
        channel: "substack",
        status: "requires_owner_approval",
        modelRewriteAllowed: false,
        tutorialId: "paper-trade-first-authority-map",
        sourceSha256,
        bodySha256,
        approval: {
          decision: "pending",
          tutorialId: "paper-trade-first-authority-map",
          sourceSha256,
          bodySha256,
        },
      },
    };
    expect(tutorialApprovalEchoFromDraft(handoff)).toEqual({
      tutorialId: "paper-trade-first-authority-map",
      sourceSha256,
      bodySha256,
    });
    expect(tutorialApprovalEchoFromDraft({
      tutorialHandoff: {
        ...handoff.tutorialHandoff,
        bodySha256: "c".repeat(64),
      },
    })).toBeNull();
  });

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
