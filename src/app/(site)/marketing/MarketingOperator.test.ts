import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  X_MENTION_APPROVAL_REGISTRY,
  X_MENTION_TEMPLATE_REGISTRY_DIGEST,
} from "@/lib/marketing/x-mention-registry";

import {
  DISCORD_PREFLIGHT_BUTTON_LABEL,
  discordActivationSummary,
  discordPreflightRequestIsCurrent,
  hasSubstackEditorHandoff,
  LeadDeleteControls,
  leadDeleteTriggerId,
  leadOperationIsCurrent,
  leadReplyHref,
  mountXApprovalPacketCopyLifecycle,
  operatorLeads,
  operatorSyndicationItems,
  operatorResetClearsSyndicationRepair,
  parseSyndicationRepairPair,
  parseSubstackVerification,
  parseDiscordActivationVerification,
  parseLeadScorecard,
  parseXActivationStatus,
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
  SubstackPublicationReceipt,
  substackVerificationResponseIsCurrent,
  tutorialApprovalEchoFromDraft,
  type OperatorSyndicationItem,
  type XActivationStatus,
  writeCurrentXActivationApprovalPacket,
  writeSubstackClipboard,
  writeSubstackManifestPatchClipboard,
  writeXActivationApprovalPacket,
  XActivationApprovalPanel,
  xActivationApprovalPacket,
  xActivationRows,
  xApprovalPacketCopyRequestIsCurrent,
  xIdentityRequestIsCurrent,
} from "./MarketingOperator";

const VALID_DISCORD_PREFLIGHT = {
  service: "OpenZaps Discord destination and command-manifest preflight",
  destination: {
    schemaVersion: 1,
    channel: "discord",
    transport: "webhook",
    scope: "configured_guild_channel",
    verified: true,
    mutationsPerformed: false,
  },
  commandReadback: {
    schemaVersion: 1,
    status: "in_sync",
    scope: "configured_application_guild",
    verified: true,
    providerReadbackVerified: true,
    managedCommandsInSync: true,
    guildPermissionVisibility: "unchecked",
    liveInvocationVerified: false,
    manifestSha256: "a".repeat(64),
    managedReadbackSha256: "a".repeat(64),
    counts: { desired: 3, remote: 3, create: 0, update: 0, delete: 0 },
    writesPerformed: false,
  },
  invocationReadback: {
    schemaVersion: 1,
    status: "current_manifest_seen",
    scope: "privacy_safe_configured_target_receipts",
    manifestSha256: "a".repeat(64),
    commands: [
      {
        command: "ask",
        observed: true,
        firstVerifiedAt: "2026-08-02T07:58:00.000Z",
      },
      { command: "openzaps", observed: false, firstVerifiedAt: null },
      { command: "status", observed: false, firstVerifiedAt: null },
    ],
    anyVerifiedInvocationObserved: true,
    allCommandsObserved: false,
    responseDeliveryVerified: false,
    uniqueInvocationsCounted: false,
    writesPerformed: false,
  },
  writesPerformed: false,
};

const VALID_X_ACTIVATION_RESPONSE = {
  service: "OpenZaps marketing agent",
  config: {
    enabled: true,
    dryRun: false,
    xAutomatedLabelConfirmed: true,
    dailyCaps: { xReplies: 10 },
    readiness: {
      configurationValid: true,
      durableLedgerConfigured: true,
      channels: { x: true },
    },
  },
  policy: {
    xAutomaticReplyScope:
      "official mentions timeline only; exact reviewed deterministic commands; first-run baseline; one reply per interaction; opt-out; all other content remains review-only",
  },
  xActivationEvidence: {
    schemaVersion: 2,
    evaluatedAt: "2026-08-03T16:00:00.000Z",
    expectedAccountIdentity: { accountId: "123456789", username: "0xzaps" },
    privacyUrl: "https://www.0xzaps.com/legal#request-data",
    templates: X_MENTION_APPROVAL_REGISTRY.map(
      ({ templateId, prompts, body }) => ({
        templateId,
        prompts: [...prompts],
        body,
      }),
    ),
  },
  xMentionAutomation: {
    ingestRequested: true,
    autoReplyRequested: true,
    autoResponseApproved: true,
    commercialUseApproved: true,
    complianceAttested: true,
    complianceReady: true,
    complianceHealth: "healthy",
    complianceValidUntil: "2026-08-03T16:25:00.000Z",
    templateApprovalDigestValid: true,
    templateRegistryDigest: X_MENTION_TEMPLATE_REGISTRY_DIGEST,
    hashSecretConfigured: true,
    canonicalUsernameBound: true,
    ingestReady: true,
    autoReplyReady: true,
    dailyCap: 1,
    blockers: [] as string[],
  },
  xComplianceHealth: {
    result: "healthy",
    checkedAt: "2026-08-03T15:55:00.000Z",
    validUntil: "2026-08-03T16:25:00.000Z",
    subjectCount: 3,
    nonPresentCount: 0,
    hold: false,
  },
};

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

describe("X activation approval evidence", () => {
  it("accepts the complete bounded status contract and renders every gate", () => {
    const parsed = parseXActivationStatus(VALID_X_ACTIVATION_RESPONSE);

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      expectedAccountIdentity: {
        accountId: "123456789",
        username: "0xzaps",
      },
      automation: {
        ingestReady: true,
        autoReplyReady: true,
        dailyCap: 1,
        templateRegistryDigest: X_MENTION_TEMPLATE_REGISTRY_DIGEST,
        canonicalUsernameBound: true,
      },
      complianceHealth: {
        result: "healthy",
        subjectCount: 3,
        nonPresentCount: 0,
        hold: false,
      },
      xReplyDailyCap: 10,
      automatedLabelAttested: true,
    });

    const rows = xActivationRows(parsed as XActivationStatus);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey).toHaveProperty("size", 23);
    expect(byKey.get("xMentionIngestRequested")?.state).toBe("requested");
    expect(byKey.get("xAutoReplyRequested")?.state).toBe("requested");
    expect(byKey.get("xAutoResponseApproved")?.state).toBe("recorded");
    expect(byKey.get("xCommercialUseApproved")?.state).toBe("recorded");
    expect(byKey.get("xComplianceAttested")?.state).toBe("recorded");
    expect(byKey.get("xComplianceReady")?.state).toBe("ready");
    expect(byKey.get("xAutomationComplianceView")?.detail).toContain(
      "2026-08-03T16:25:00.000Z",
    );
    expect(byKey.get("xHashSecretConfigured")?.detail).toContain(
      "value is never returned",
    );
    expect(byKey.get("xTemplateDigestApproved")?.detail).toContain(
      X_MENTION_TEMPLATE_REGISTRY_DIGEST,
    );
    expect(byKey.get("xCanonicalUsernameBound")?.state).toBe("@0xzaps bound");
    expect(byKey.get("xMentionIngestReady")?.state).toBe("locally ready");
    expect(byKey.get("xAutoReplyReady")?.state).toBe("locally ready");
    expect(byKey.get("xAutomaticReplyDailyCap")?.detail).toContain(
      "1 automatic reply",
    );
    expect(byKey.get("xComplianceCheckedAt")?.detail).toContain(
      "2026-08-03T15:55:00.000Z",
    );
    expect(byKey.get("xComplianceCoverage")?.detail).toContain(
      "3 subjects checked",
    );
    expect(byKey.get("xComplianceHold")?.state).toBe("clear");
    expect(byKey.get("xAutomatedLabelExternal")).toMatchObject({
      ready: false,
      state: "external verification required",
    });
    expect(byKey.get("xApiCreditsExternal")).toMatchObject({
      ready: false,
      state: "external verification required",
    });
  });

  it("fails the whole panel closed on missing, contradictory, or unsafe fields", () => {
    const missingGate = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    delete (missingGate.xMentionAutomation as Partial<
      typeof missingGate.xMentionAutomation
    >).autoReplyRequested;

    const mismatchedHealth = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    mismatchedHealth.xMentionAutomation.complianceHealth = "stale";

    const unexpectedTemplate = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    unexpectedTemplate.xActivationEvidence.templates[0].templateId =
      "other-v1" as unknown as typeof unexpectedTemplate.xActivationEvidence.templates[0]["templateId"];

    const changedPrompt = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    changedPrompt.xActivationEvidence.templates[0].prompts[0] =
      "/changed" as unknown as typeof changedPrompt.xActivationEvidence.templates[0]["prompts"][0];

    const changedResponse = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    changedResponse.xActivationEvidence.templates[0].body += " changed";

    const changedDigest = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    changedDigest.xMentionAutomation.templateRegistryDigest = "0".repeat(64);

    const noncanonicalIdentity = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    noncanonicalIdentity.xActivationEvidence.expectedAccountIdentity.username =
      "otheraccount";

    const unsafeBlocker = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    unsafeBlocker.xMentionAutomation.blockers = [
      "provider secret value was abc123",
    ];

    expect(parseXActivationStatus(missingGate)).toBeNull();
    expect(parseXActivationStatus(mismatchedHealth)).toBeNull();
    expect(parseXActivationStatus(unexpectedTemplate)).toBeNull();
    expect(parseXActivationStatus(changedPrompt)).toBeNull();
    expect(parseXActivationStatus(changedResponse)).toBeNull();
    expect(parseXActivationStatus(changedDigest)).toBeNull();
    expect(parseXActivationStatus(noncanonicalIdentity)).toBeNull();
    expect(parseXActivationStatus(unsafeBlocker)).toBeNull();
  });

  it("rejects every invalid compliance result, timestamp, coverage, and hold combination", () => {
    const accountNotFoundWithCounts = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    accountNotFoundWithCounts.xComplianceHealth = {
      result: "account_not_found",
      checkedAt: null as unknown as string,
      validUntil: null as unknown as string,
      subjectCount: 1,
      nonPresentCount: 0,
      hold: false,
    };
    accountNotFoundWithCounts.xMentionAutomation = {
      ...accountNotFoundWithCounts.xMentionAutomation,
      complianceHealth: "account_not_found",
      complianceValidUntil: null as unknown as string,
      complianceReady: false,
      ingestReady: false,
      autoReplyReady: false,
      blockers: [
        "X mention ingestion requires a fresh healthy compliance checkpoint; current state is account_not_found.",
      ],
    };

    const staleWithHold = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    staleWithHold.xComplianceHealth.result = "stale";
    staleWithHold.xComplianceHealth.hold = true;
    staleWithHold.xMentionAutomation = {
      ...staleWithHold.xMentionAutomation,
      complianceHealth: "stale",
      complianceReady: false,
      ingestReady: false,
      autoReplyReady: false,
      blockers: [
        "X mention ingestion requires a fresh healthy compliance checkpoint; current state is stale.",
      ],
    };

    const holdWithoutHold = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    holdWithoutHold.xComplianceHealth.result = "hold";
    holdWithoutHold.xMentionAutomation = {
      ...holdWithoutHold.xMentionAutomation,
      complianceHealth: "hold",
      complianceReady: false,
      ingestReady: false,
      autoReplyReady: false,
      blockers: [
        "X mention ingestion requires a fresh healthy compliance checkpoint; current state is hold.",
      ],
    };

    const healthyWithoutCoverage = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    healthyWithoutCoverage.xComplianceHealth.subjectCount = 0;

    const mismatchedTimestamps = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    mismatchedTimestamps.xComplianceHealth.validUntil =
      null as unknown as string;
    mismatchedTimestamps.xMentionAutomation.complianceValidUntil =
      null as unknown as string;

    const falseComplianceReady = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    falseComplianceReady.xMentionAutomation.complianceReady = false;

    for (const response of [
      accountNotFoundWithCounts,
      staleWithHold,
      holdWithoutHold,
      healthyWithoutCoverage,
      mismatchedTimestamps,
      falseComplianceReady,
    ]) {
      expect(parseXActivationStatus(response)).toBeNull();
    }
  });

  it("rejects missing, spurious, misordered, or flag-incoherent blockers and readiness", () => {
    const missingRequiredBlocker = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    missingRequiredBlocker.xMentionAutomation.hashSecretConfigured = false;
    missingRequiredBlocker.xMentionAutomation.ingestReady = false;
    missingRequiredBlocker.xMentionAutomation.autoReplyReady = false;

    const spuriousBlocker = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    spuriousBlocker.xMentionAutomation.blockers = [
      "OPENZAPS_X_MENTION_HASH_SECRET must be a server-only secret of at least 32 characters.",
    ];

    const errorWithTrueFlag = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    errorWithTrueFlag.xMentionAutomation.blockers = [
      'OPENZAPS_X_MENTION_INGEST_ENABLED must be exactly "true" or "false".',
    ];

    const conditionalBeforeError = structuredClone(
      VALID_X_ACTIVATION_RESPONSE,
    );
    conditionalBeforeError.xMentionAutomation = {
      ...conditionalBeforeError.xMentionAutomation,
      ingestRequested: false,
      ingestReady: false,
      autoReplyReady: false,
      blockers: [
        "Automatic X replies require X mention ingestion.",
        'OPENZAPS_X_MENTION_INGEST_ENABLED must be exactly "true" or "false".',
      ],
    };

    const falseReadyFlag = structuredClone(VALID_X_ACTIVATION_RESPONSE);
    falseReadyFlag.xMentionAutomation.autoReplyReady = false;

    for (const response of [
      missingRequiredBlocker,
      spuriousBlocker,
      errorWithTrueFlag,
      conditionalBeforeError,
      falseReadyFlag,
    ]) {
      expect(parseXActivationStatus(response)).toBeNull();
    }
  });

  it("accepts an explicitly off, unavailable checkpoint without claiming readiness", () => {
    const disabled = {
      ...VALID_X_ACTIVATION_RESPONSE,
      config: {
        ...VALID_X_ACTIVATION_RESPONSE.config,
        xAutomatedLabelConfirmed: false,
        readiness: {
          ...VALID_X_ACTIVATION_RESPONSE.config.readiness,
          channels: { x: false },
        },
      },
      xActivationEvidence: {
        ...VALID_X_ACTIVATION_RESPONSE.xActivationEvidence,
        expectedAccountIdentity: null,
      },
      xMentionAutomation: {
        ...VALID_X_ACTIVATION_RESPONSE.xMentionAutomation,
        ingestRequested: false,
        autoReplyRequested: false,
        autoResponseApproved: false,
        commercialUseApproved: false,
        complianceAttested: false,
        complianceReady: false,
        complianceHealth: "unavailable",
        complianceValidUntil: null,
        templateApprovalDigestValid: false,
        hashSecretConfigured: false,
        canonicalUsernameBound: false,
        ingestReady: false,
        autoReplyReady: false,
        blockers: [],
      },
      xComplianceHealth: null,
    };

    const parsed = parseXActivationStatus(disabled);
    expect(parsed).toMatchObject({
      expectedAccountIdentity: null,
      automatedLabelAttested: false,
      automation: {
        ingestRequested: false,
        autoReplyRequested: false,
        complianceHealth: "unavailable",
        complianceValidUntil: null,
        ingestReady: false,
        autoReplyReady: false,
      },
      complianceHealth: null,
    });
    expect(
      xActivationRows(parsed as XActivationStatus)
        .find((row) => row.key === "xComplianceHold"),
    ).toMatchObject({ ready: false, state: "unavailable" });
  });

  it("builds and copies a non-authorizing packet with the complete approval scope", async () => {
    const parsed = parseXActivationStatus(VALID_X_ACTIVATION_RESPONSE);
    expect(parsed).not.toBeNull();
    const packet = xActivationApprovalPacket(parsed as XActivationStatus);

    expect(packet).toContain("DOES NOT ENABLE OR AUTHORIZE AUTOMATION");
    expect(packet).toContain("@0xzaps (account 123456789)");
    expect(packet).toContain("1 deterministic automatic reply per UTC day");
    expect(packet).toContain("global 10 X-reply cap");
    expect(packet).toContain("@0xzaps stop");
    expect(packet).toContain("https://www.0xzaps.com/legal#request-data");
    expect(packet).toContain("about-v1\nExact eligible prompts:\n- /about");
    expect(packet).toContain("Exact response:\nOpenZaps lets an owner pre-commit");
    expect(packet).toContain("Automated label is visibly applied");
    expect(packet).toContain("API credits and account-spend availability");
    expect(packet).toContain("external verification required");

    const writeText = vi.fn(async () => undefined);
    await writeXActivationApprovalPacket(packet, { writeText });
    expect(writeText).toHaveBeenCalledWith(packet);
    await expect(
      writeXActivationApprovalPacket(packet, undefined),
    ).rejects.toThrow("Clipboard unavailable");
  });

  it("invalidates copied state after packet refresh and ignores stale in-flight writes", async () => {
    expect(xApprovalPacketCopyRequestIsCurrent({
      requestedPacket: "old packet",
      currentPacket: "new packet",
      requestGeneration: 1,
      currentRequestGeneration: 1,
      active: true,
    })).toBe(false);
    expect(xApprovalPacketCopyRequestIsCurrent({
      requestedPacket: "same packet",
      currentPacket: "same packet",
      requestGeneration: 1,
      currentRequestGeneration: 2,
      active: true,
    })).toBe(false);
    expect(xApprovalPacketCopyRequestIsCurrent({
      requestedPacket: "same packet",
      currentPacket: "same packet",
      requestGeneration: 1,
      currentRequestGeneration: 1,
      active: false,
    })).toBe(false);

    let resolveWrite: (() => void) | undefined;
    const clipboard = {
      writeText: vi.fn(() => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })),
    };
    let current = {
      packet: "old packet",
      requestGeneration: 1,
      active: true,
    };
    const pending = writeCurrentXActivationApprovalPacket({
      packet: "old packet",
      clipboard,
      requestGeneration: 1,
      currentRequest: () => current,
    });
    current = {
      packet: "new packet",
      requestGeneration: 2,
      active: true,
    };
    resolveWrite?.();

    await expect(pending).resolves.toBe("stale");
    expect(clipboard.writeText).toHaveBeenCalledWith("old packet");
  });

  it("reactivates copy lifecycle after Strict Mode effect replay", () => {
    const lifecycle = { active: false, requestGeneration: 0 };

    const firstCleanup = mountXApprovalPacketCopyLifecycle(lifecycle);
    expect(lifecycle).toEqual({ active: true, requestGeneration: 0 });
    firstCleanup();
    expect(lifecycle).toEqual({ active: false, requestGeneration: 1 });

    const secondCleanup = mountXApprovalPacketCopyLifecycle(lifecycle);
    expect(lifecycle).toEqual({ active: true, requestGeneration: 1 });
    secondCleanup();
    expect(lifecycle).toEqual({ active: false, requestGeneration: 2 });
  });

  it("renders only a copy control and keeps malformed evidence non-actionable", () => {
    const parsed = parseXActivationStatus(VALID_X_ACTIVATION_RESPONSE);
    const validMarkup = renderToStaticMarkup(
      createElement(XActivationApprovalPanel, { status: parsed }),
    );
    const invalidMarkup = renderToStaticMarkup(
      createElement(XActivationApprovalPanel, { status: null }),
    );
    const buttons = validMarkup.match(/<button\b/gu) ?? [];

    expect(buttons).toHaveLength(1);
    expect(validMarkup).toContain("Copy approval packet");
    expect(validMarkup).toContain("External verification still required");
    expect(validMarkup).toContain("how do i try virtual trading");
    expect(validMarkup).toContain("Try Virtual Trading with 10,000 virtual USDG");
    expect(validMarkup).not.toMatch(/>Enable(?:\s|<)/u);
    expect(validMarkup).not.toMatch(/>Post(?:\s|<)/u);
    expect(validMarkup).not.toMatch(/>Reply(?:\s|<)/u);
    expect(invalidMarkup).toContain("X activation evidence unavailable.");
    expect(invalidMarkup).not.toContain("<button");
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

describe("Discord activation evidence", () => {
  it("accepts only bounded read-only destination and command evidence", () => {
    const parsed = parseDiscordActivationVerification(VALID_DISCORD_PREFLIGHT);

    expect(parsed).toMatchObject({
      destination: { transport: "webhook", verified: true },
      commandReadback: {
        status: "in_sync",
        managedCommandsInSync: true,
        counts: { desired: 3, create: 0, update: 0 },
        writesPerformed: false,
      },
      invocationReadback: {
        status: "current_manifest_seen",
        commands: [
          { command: "ask", observed: true },
          { command: "openzaps", observed: false },
          { command: "status", observed: false },
        ],
        anyVerifiedInvocationObserved: true,
        allCommandsObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
      writesPerformed: false,
    });
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Official manifest: the provider projection matches all 3 source-controlled managed commands.",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Permission visibility: unchecked",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Signed-handler observation: current-manifest receipt observed for /ask",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Not observed: /openzaps, /status",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "does not establish current provider registration, guild permission visibility, ongoing command availability, or response delivery",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Response delivery: not verified",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "Unique invocations: not counted",
    );
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "no command was registered or changed",
    );
    expect(DISCORD_PREFLIGHT_BUTTON_LABEL).toBe(
      "Verify Discord destination, manifest, and invocation receipts",
    );
    expect(DISCORD_PREFLIGHT_BUTTON_LABEL).not.toMatch(
      /activation|permissions? verified|invocation verified/iu,
    );
  });

  it("keeps current-manifest signed-handler receipts separate from permissions and response delivery", () => {
    const parsed = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...VALID_DISCORD_PREFLIGHT.invocationReadback,
        commands: [
          {
            command: "status",
            observed: true,
            firstVerifiedAt: "2026-08-02T08:02:00.000Z",
          },
          {
            command: "ask",
            observed: true,
            firstVerifiedAt: "2026-08-02T07:58:00.000Z",
          },
          {
            command: "openzaps",
            observed: true,
            firstVerifiedAt: "2026-08-02T08:00:00.000Z",
          },
        ],
        allCommandsObserved: true,
      },
    });

    expect(parsed?.invocationReadback).toMatchObject({
      status: "current_manifest_seen",
      commands: [
        { command: "ask", observed: true },
        { command: "openzaps", observed: true },
        { command: "status", observed: true },
      ],
      anyVerifiedInvocationObserved: true,
      allCommandsObserved: true,
      responseDeliveryVerified: false,
      uniqueInvocationsCounted: false,
    });
    const summary = parsed ? discordActivationSummary(parsed) : "";
    expect(summary).toContain("Official manifest:");
    expect(summary).toContain("Permission visibility: unchecked");
    expect(summary).toContain(
      "Signed-handler observation: current-manifest receipts observed for /ask",
    );
    expect(summary).toContain("/openzaps");
    expect(summary).toContain("/status");
    expect(summary).toContain("Response delivery: not verified");
    expect(summary).not.toMatch(/response delivery: verified/iu);
    expect(summary).not.toMatch(/permission visibility: verified/iu);
  });

  it("accepts honest not-observed and unavailable receipt lanes without erasing other proof", () => {
    const notObserved = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...VALID_DISCORD_PREFLIGHT.invocationReadback,
        status: "not_observed",
        commands: VALID_DISCORD_PREFLIGHT.invocationReadback.commands.map(
          (command) => ({
            ...command,
            observed: false,
            firstVerifiedAt: null,
          }),
        ),
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
      },
    });
    const unavailable = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        schemaVersion: 1,
        status: "unavailable",
        scope: "privacy_safe_configured_target_receipts",
        manifestSha256: null,
        commands: [],
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
    });

    expect(notObserved).toMatchObject({
      destination: { verified: true },
      commandReadback: { status: "in_sync" },
      invocationReadback: {
        status: "not_observed",
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
      },
    });
    expect(notObserved && discordActivationSummary(notObserved)).toContain(
      "no current-manifest receipt was observed for /ask, /openzaps, or /status",
    );
    expect(unavailable).toMatchObject({
      destination: { verified: true },
      commandReadback: { status: "in_sync" },
      invocationReadback: {
        status: "unavailable",
        manifestSha256: null,
        commands: [],
      },
    });
    expect(unavailable && discordActivationSummary(unavailable)).toContain(
      "privacy-safe current-manifest receipt readback is unavailable",
    );
  });

  it("keeps missing command credentials explicit while the destination is healthy", () => {
    const parsed = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        schemaVersion: 1,
        status: "not_configured",
        scope: "configured_application_guild",
        verified: false,
        providerReadbackVerified: false,
        managedCommandsInSync: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      },
    });

    expect(parsed).toMatchObject({
      destination: { verified: true },
      commandReadback: { status: "not_configured", verified: false },
    });
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "server credential is missing or invalid",
    );
  });

  it("accepts bounded managed-command drift and explains the exact counts", () => {
    const parsed = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        ...VALID_DISCORD_PREFLIGHT.commandReadback,
        status: "drift",
        managedCommandsInSync: false,
        managedReadbackSha256: "b".repeat(64),
        counts: { desired: 3, remote: 2, create: 1, update: 0, delete: 0 },
      },
    });

    expect(parsed).toMatchObject({
      destination: { verified: true },
      commandReadback: {
        status: "drift",
        managedCommandsInSync: false,
        counts: { create: 1, update: 0 },
      },
    });
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "found 1 missing and 0 drifted managed commands",
    );
  });

  it("accepts an unavailable command provider without erasing destination proof", () => {
    const parsed = parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        schemaVersion: 1,
        status: "unavailable",
        scope: "configured_application_guild",
        verified: false,
        providerReadbackVerified: false,
        managedCommandsInSync: false,
        guildPermissionVisibility: "unchecked",
        liveInvocationVerified: false,
        writesPerformed: false,
      },
    });

    expect(parsed).toMatchObject({
      destination: { verified: true },
      commandReadback: { status: "unavailable", verified: false },
    });
    expect(parsed && discordActivationSummary(parsed)).toContain(
      "currently unavailable",
    );
  });

  it("rejects malformed, oversized, or internally inconsistent command evidence", () => {
    expect(parseDiscordActivationVerification([])).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      writesPerformed: true,
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        ...VALID_DISCORD_PREFLIGHT.commandReadback,
        counts: {
          ...VALID_DISCORD_PREFLIGHT.commandReadback.counts,
          remote: 131,
        },
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        ...VALID_DISCORD_PREFLIGHT.commandReadback,
        counts: {
          ...VALID_DISCORD_PREFLIGHT.commandReadback.counts,
          remote: 0,
        },
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        ...VALID_DISCORD_PREFLIGHT.commandReadback,
        managedReadbackSha256: "b".repeat(64),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      commandReadback: {
        ...VALID_DISCORD_PREFLIGHT.commandReadback,
        manifestSha256: "provider-secret",
      },
    })).toBeNull();
  });

  it("rejects malformed, stale-manifest, or internally inconsistent invocation evidence", () => {
    const invocation = VALID_DISCORD_PREFLIGHT.invocationReadback;
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: undefined,
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        manifestSha256: "b".repeat(64),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        manifestSha256: ` ${"a".repeat(64)} `,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: [
          invocation.commands[0],
          invocation.commands[0],
          invocation.commands[2],
        ],
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: invocation.commands.map((command) =>
          command.command === "ask"
            ? {
                ...command,
                firstVerifiedAt: "2026-08-02T07:58:00Z",
              }
            : command
        ),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: invocation.commands.map((command) =>
          command.command === "ask"
            ? { ...command, firstVerifiedAt: null }
            : command
        ),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: invocation.commands.map((command) =>
          command.command === "openzaps"
            ? {
                ...command,
                firstVerifiedAt: "2026-08-02T08:00:00.000Z",
              }
            : command
        ),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        status: "not_observed",
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        anyVerifiedInvocationObserved: false,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        allCommandsObserved: true,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        responseDeliveryVerified: true,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        uniqueInvocationsCounted: true,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        writesPerformed: true,
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        providerBody: "must-not-be-accepted",
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: invocation.commands.map((command) =>
          command.command === "ask"
            ? { ...command, userId: "private-user-id" }
            : command
        ),
      },
    })).toBeNull();
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        schemaVersion: 1,
        status: "unavailable",
        scope: "privacy_safe_configured_target_receipts",
        manifestSha256: "a".repeat(64),
        commands: [],
        anyVerifiedInvocationObserved: false,
        allCommandsObserved: false,
        responseDeliveryVerified: false,
        uniqueInvocationsCounted: false,
        writesPerformed: false,
      },
    })).toBeNull();
  });

  it("rejects canonical Discord invocation timestamps with sub-minute precision", () => {
    const invocation = VALID_DISCORD_PREFLIGHT.invocationReadback;
    expect(parseDiscordActivationVerification({
      ...VALID_DISCORD_PREFLIGHT,
      invocationReadback: {
        ...invocation,
        commands: invocation.commands.map((command) =>
          command.command === "ask"
            ? {
                ...command,
                firstVerifiedAt: "2026-08-02T07:58:00.001Z",
              }
            : command
        ),
      },
    })).toBeNull();
  });
});

describe("Discord preflight request lifecycle", () => {
  it("rejects a response after either refresh or session invalidation", () => {
    expect(discordPreflightRequestIsCurrent({
      requestGeneration: 3,
      currentRequestGeneration: 3,
      sessionGeneration: 5,
      currentSessionGeneration: 5,
    })).toBe(true);
    expect(discordPreflightRequestIsCurrent({
      requestGeneration: 3,
      currentRequestGeneration: 4,
      sessionGeneration: 5,
      currentSessionGeneration: 5,
    })).toBe(false);
    expect(discordPreflightRequestIsCurrent({
      requestGeneration: 3,
      currentRequestGeneration: 3,
      sessionGeneration: 5,
      currentSessionGeneration: 6,
    })).toBe(false);
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

describe("operator lead scorecard parsing", () => {
  const SCORECARD = {
    schemaVersion: 1,
    generatedAt: "2026-08-02T05:30:00.000Z",
    scope: {
      basis: "accepted_requests_onward",
      population: "nonexpired_stored_requests",
      selection: "qualification_score_desc_then_created_at_desc",
      maxRows: 100,
      returnedRows: 4,
      truncated: false,
      complete: true,
    },
    windows: {
      days7: {
        accepted: 4,
        score3Plus: 3,
        progressed: 2,
        currentQualified: 1,
      },
      days30: {
        accepted: 4,
        score3Plus: 3,
        progressed: 2,
        currentQualified: 1,
      },
    },
    overdueReviewCount: 1,
    stages: { new: 2, contacted: 1, qualified: 1, closed: 0 },
    attribution: [{
      source: "x",
      campaign: "agent_kit",
      content: "feed_update",
      accepted: 2,
      score3Plus: 2,
      currentQualified: 1,
    }, {
      source: "discord",
      campaign: "learn_hub",
      content: "hero",
      accepted: 2,
      score3Plus: 1,
      currentQualified: 0,
    }],
  };

  it("accepts a coherent, bounded, PII-free scorecard", () => {
    expect(parseLeadScorecard({ scorecard: SCORECARD })).toEqual(SCORECARD);
  });

  it("fails closed for malformed coverage, stage totals, or dimensions", () => {
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        scope: { ...SCORECARD.scope, truncated: true },
      },
    })).toBeNull();
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        stages: { ...SCORECARD.stages, new: 3 },
      },
    })).toBeNull();
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        attribution: [{
          ...SCORECARD.attribution[0],
          campaign: "person@example.com",
        }],
      },
    })).toBeNull();
  });

  it("fails closed for duplicate, incomplete, or malformed remaining groups", () => {
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        attribution: [
          SCORECARD.attribution[0],
          SCORECARD.attribution[0],
        ],
      },
    })).toBeNull();
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        attribution: [{
          ...SCORECARD.attribution[0],
          accepted: 1,
          score3Plus: 1,
        }],
      },
    })).toBeNull();
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        attribution: [{
          ...SCORECARD.attribution[0],
          source: "remaining",
        }, SCORECARD.attribution[1]],
      },
    })).toBeNull();
  });

  it("accepts only a producer-coherent final remaining bucket", () => {
    const visible = [
      "discord",
      "farcaster",
      "github",
      "homepage",
      "newsletter",
      "openzaps",
      "rss",
      "substack",
      "x",
    ].map((source) => ({
      source,
      campaign: "agent_kit",
      content: "feed_update",
      accepted: 1,
      score3Plus: 1,
      currentQualified: 0,
    }));
    visible.push({
      source: "x",
      campaign: "learn_hub",
      content: "hero",
      accepted: 1,
      score3Plus: 1,
      currentQualified: 0,
    }, {
      source: "discord",
      campaign: "learn_hub",
      content: "hero",
      accepted: 1,
      score3Plus: 1,
      currentQualified: 0,
    });
    const remaining = {
      source: "remaining",
      campaign: "remaining",
      content: "remaining",
      accepted: 2,
      score3Plus: 2,
      currentQualified: 0,
    };
    const coherent = {
      ...SCORECARD,
      scope: { ...SCORECARD.scope, returnedRows: 13 },
      windows: {
        days7: {
          accepted: 13,
          score3Plus: 13,
          progressed: 0,
          currentQualified: 0,
        },
        days30: {
          accepted: 13,
          score3Plus: 13,
          progressed: 0,
          currentQualified: 0,
        },
      },
      overdueReviewCount: 0,
      stages: { new: 13, contacted: 0, qualified: 0, closed: 0 },
      attribution: [...visible, remaining],
    };

    expect(parseLeadScorecard({ scorecard: coherent })).toEqual(coherent);
    expect(parseLeadScorecard({
      scorecard: {
        ...coherent,
        attribution: [...visible.slice(0, -1), remaining],
      },
    })).toBeNull();
  });

  it("rejects window lifecycle counts that exceed the stored stages", () => {
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        windows: {
          ...SCORECARD.windows,
          days30: {
            ...SCORECARD.windows.days30,
            currentQualified: 2,
          },
        },
        attribution: SCORECARD.attribution.map((row, index) => ({
          ...row,
          currentQualified: index === 0 ? 2 : 0,
        })),
      },
    })).toBeNull();
    expect(parseLeadScorecard({
      scorecard: {
        ...SCORECARD,
        windows: {
          ...SCORECARD.windows,
          days30: {
            ...SCORECARD.windows.days30,
            progressed: 4,
          },
        },
      },
    })).toBeNull();
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
    tutorialId: "paper-trade-first-authority-map",
    approvedTitle: "Paper Trade First",
    sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
  };
  const expectedManifestEntry = {
    id: "paper-trade-first-authority-map",
    title: "Paper Trade First",
    sourcePath: "docs/tutorials/paper-trade-first-authority-map.md",
    status: "rss_confirmed" as const,
    canonicalUrl: expectedReceipt.canonicalUrl,
    publishedAt: "2026-08-01T01:00:00.000Z",
  };
  const expectedManifestPatch = JSON.stringify(expectedManifestEntry, null, 2);

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

  it("accepts only a bounded durable RSS verification receipt", () => {
    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        canonicalUrl: expectedReceipt.canonicalUrl,
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        publishedAt: "2026-08-01T01:00:00.000Z",
        persisted: true,
        receiptResult: "recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: expectedManifestPatch,
      }, expectedReceipt),
    ).toMatchObject({
      status: "rss_confirmed",
      persisted: true,
      receiptResult: "recorded",
      manifestEntry: expectedManifestEntry,
      manifestPatch: expectedManifestPatch,
    });

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        publishedAt: expectedManifestEntry.publishedAt,
        persisted: true,
        receiptResult: "already_recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: expectedManifestPatch,
      }, expectedReceipt),
    ).toMatchObject({ receiptResult: "already_recorded" });

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        publishedAt: expectedManifestEntry.publishedAt,
        persisted: false,
      }, expectedReceipt),
    ).toBeNull();

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        canonicalUrl: expectedReceipt.canonicalUrl,
        approvedTitle: "Paper Trade First",
        feedUrl: "https://attacker.example/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        persisted: true,
        receiptResult: "recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: expectedManifestPatch,
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
        publishedAt: expectedManifestEntry.publishedAt,
        persisted: true,
        receiptResult: "recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: expectedManifestPatch,
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
        publishedAt: expectedManifestEntry.publishedAt,
        persisted: true,
        receiptResult: "recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: expectedManifestPatch,
      }, expectedReceipt),
    ).toBeNull();

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "rss_confirmed",
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        publishedAt: expectedManifestEntry.publishedAt,
        persisted: true,
        receiptResult: "recorded",
        manifestEntry: expectedManifestEntry,
        manifestPatch: JSON.stringify({
          ...expectedManifestEntry,
          canonicalUrl: "https://defitutorials.substack.com/p/tampered",
        }, null, 2),
      }, expectedReceipt),
    ).toBeNull();

    expect(
      parseSubstackVerification({
        ...expectedReceipt,
        status: "title_mismatch",
        approvedTitle: "Paper Trade First",
        feedUrl: "https://defitutorials.substack.com/feed",
        checkedAt: "2026-08-01T02:00:00.000Z",
        persisted: false,
      }, expectedReceipt),
    ).toMatchObject({ status: "title_mismatch", persisted: false });
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

  it("copies the exact manifest replacement object without rewriting it", async () => {
    const clipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      writeSubstackManifestPatchClipboard(expectedManifestPatch, clipboard),
    ).resolves.toBeUndefined();
    expect(clipboard.writeText).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith(expectedManifestPatch);
  });

  it("renders immutable receipt evidence and a read-only owner-reviewed patch", () => {
    const receipt = renderToStaticMarkup(
      createElement(SubstackPublicationReceipt, {
        verification: {
          ...expectedReceipt,
          status: "rss_confirmed",
          approvedTitle: expectedManifestEntry.title,
          feedUrl: "https://defitutorials.substack.com/feed",
          checkedAt: "2026-08-01T02:00:00.000Z",
          publishedAt: expectedManifestEntry.publishedAt,
          persisted: true,
          receiptResult: "recorded",
          manifestEntry: expectedManifestEntry,
          manifestPatch: expectedManifestPatch,
        },
      }),
    );

    expect(receipt).toContain('aria-label="Immutable Substack publication receipt"');
    expect(receipt).toContain("RSS publication receipt recorded");
    expect(receipt).toContain("Exact manifest replacement object");
    expect(receipt).toContain('aria-label="Exact tutorial manifest patch"');
    expect(receipt).toContain('readOnly=""');
    expect(receipt).toContain("Copy exact manifest patch");
    expect(receipt).toContain("Owner review is still required");
    expect(receipt).toContain("docs/tutorials/manifest.json");
    expect(receipt).toContain("never edits Substack or repository files automatically");
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
    expect(approvedHandoff).toContain("stores an immutable evidence receipt");
    expect(approvedHandoff).not.toContain("persist an RSS-confirmed receipt");
  });
});
