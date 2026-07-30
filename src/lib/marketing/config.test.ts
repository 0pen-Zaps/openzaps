import { describe, expect, it } from "vitest";

import { DEFAULT_MARKETING_DAILY_CAPS, readMarketingConfig } from "@/lib/marketing/config";

describe("readMarketingConfig", () => {
  it("defaults to disabled, dry-run, and no channel authority", () => {
    const config = readMarketingConfig({});

    expect(config).toMatchObject({
      enabled: false,
      dryRun: true,
      autoPublishRequested: false,
      autoPublish: false,
      xAiReplyApproved: false,
      xAutomatedLabelConfirmed: false,
      mode: "disabled",
      dailyCaps: DEFAULT_MARKETING_DAILY_CAPS,
      readiness: {
        configurationValid: true,
        canDraft: false,
        durableLedgerConfigured: false,
        autoPublishReady: false,
        channels: {
          x: false,
          discordBroadcast: false,
          discordInteractions: false,
          directMessages: false,
          substackDirectPublish: false,
          substackManualHandoff: true,
          farcaster: false,
          github: false,
        },
      },
    });
    expect(config.readiness.blockers).toContain("OPENZAPS_MARKETING_ENABLED is not true.");
  });

  it("requires exact boolean values and fails closed on an invalid cap", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "TRUE",
      OPENZAPS_MARKETING_DRY_RUN: "0",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "yes",
      OPENZAPS_X_AI_REPLY_APPROVED: "approved",
      OPENZAPS_MARKETING_DAILY_X_POST_CAP: "-1",
    });

    expect(config.enabled).toBe(false);
    expect(config.dryRun).toBe(true);
    expect(config.autoPublish).toBe(false);
    expect(config.xAiReplyApproved).toBe(false);
    expect(config.dailyCaps.xPosts).toBe(0);
    expect(config.readiness.configurationValid).toBe(false);
    expect(config.readiness.canDraft).toBe(false);
    expect(config.readiness.blockers).toHaveLength(6);
  });

  it("recognizes channel readiness without retaining credentials", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "false",
      OPENZAPS_X_AI_REPLY_APPROVED: "false",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_USER_ACCESS_TOKEN: "super-secret",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
      DISCORD_MARKETING_WEBHOOK_URL: "https://discord.com/api/webhooks/123/webhook-secret",
      DISCORD_MARKETING_CHANNEL_ID: "789",
      DISCORD_APPLICATION_PUBLIC_KEY: "ab".repeat(32),
      OPENZAPS_DISCORD_APPLICATION_ID: "456",
      OPENZAPS_DISCORD_GUILD_ID: "101112",
    });

    expect(config.mode).toBe("review_only");
    expect(config.autoPublishRequested).toBe(false);
    expect(config.autoPublish).toBe(false);
    expect(config.readiness.canDraft).toBe(false);
    expect(config.readiness.durableLedgerConfigured).toBe(false);
    expect(config.readiness.autoPublishReady).toBe(false);
    expect(config.readiness.channels).toMatchObject({
      x: true,
      discordBroadcast: true,
      discordInteractions: true,
    });
    expect(JSON.stringify(config)).not.toContain("super-secret");
    expect(JSON.stringify(config)).not.toContain("webhook-secret");
    expect(config.readiness.blockers).toContain(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
  });

  it("uses review-only mode when live publishing is enabled but auto-publish is not", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "false",
    });

    expect(config.mode).toBe("review_only");
    expect(config.readiness.canDraft).toBe(false);
    expect(config.readiness.blockers).toContain(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
  });

  it("allows side-effect-free dry-run drafting without a durable ledger", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
    });

    expect(config.mode).toBe("dry_run");
    expect(config.readiness.canDraft).toBe(true);
    expect(config.readiness.durableLedgerConfigured).toBe(false);
    expect(config.readiness.blockers).not.toContain(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
  });

  it("requires the explicit ledger gate, a valid Supabase origin, and a service-role secret", () => {
    const configured = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    expect(configured.readiness.durableLedgerConfigured).toBe(true);
    expect(configured.readiness.canDraft).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("service-secret");

    const unboundCloudProject = readMarketingConfig({
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    expect(unboundCloudProject.readiness.durableLedgerConfigured).toBe(false);

    const mismatchedCloudProject = readMarketingConfig({
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "anotherprojectref",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    expect(mismatchedCloudProject.readiness.durableLedgerConfigured).toBe(false);

    const invalidProjectRef = readMarketingConfig({
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "UPPERCASE",
    });
    expect(invalidProjectRef.readiness.configurationValid).toBe(false);

    const missingSecret = readMarketingConfig({
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    });
    expect(missingSecret.readiness.durableLedgerConfigured).toBe(false);
    expect(missingSecret.readiness.blockers).toContain(
      "The durable marketing ledger requires the exact bound Supabase project URL, OPENZAPS_MARKETING_SUPABASE_PROJECT_REF, and SUPABASE_SERVICE_ROLE_KEY.",
    );

    expect(
      readMarketingConfig({
        OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
        OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
        SUPABASE_URL: "https://ledger.example",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      }).readiness.durableLedgerConfigured,
    ).toBe(false);
    expect(
      readMarketingConfig({
        OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
        OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
        SUPABASE_URL: "https://api.abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      }).readiness.durableLedgerConfigured,
    ).toBe(false);
    expect(
      readMarketingConfig({
        OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
        OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
        SUPABASE_URL: "http://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      }).readiness.durableLedgerConfigured,
    ).toBe(false);
    expect(
      readMarketingConfig({
        OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      }).readiness.durableLedgerConfigured,
    ).toBe(true);
    expect(
      readMarketingConfig({
        NODE_ENV: "production",
        OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      }).readiness.durableLedgerConfigured,
    ).toBe(false);
  });

  it("enables only bounded auto-publish when the ledger and Discord are ready", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "true",
      OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/webhooks/123/public-token",
      OPENZAPS_DISCORD_GUILD_ID: "456",
      DISCORD_MARKETING_CHANNEL_ID: "789",
      OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });

    expect(config.autoPublishRequested).toBe(true);
    expect(config.autoPublish).toBe(true);
    expect(config.readiness.durableLedgerConfigured).toBe(true);
    expect(config.readiness.autoPublishReady).toBe(true);
    expect(config.mode).toBe("live");
    expect(JSON.stringify(config)).not.toContain("public-token");
  });

  it("keeps requested auto-publish in review-only mode until a durable ledger exists", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_MARKETING_AUTO_PUBLISH: "true",
      X_USER_ACCESS_TOKEN: "token",
    });

    expect(config.autoPublishRequested).toBe(true);
    expect(config.autoPublish).toBe(false);
    expect(config.mode).toBe("review_only");
    expect(config.readiness.configurationValid).toBe(true);
    expect(config.readiness.canDraft).toBe(false);
    expect(config.readiness.durableLedgerConfigured).toBe(false);
    expect(config.readiness.autoPublishReady).toBe(false);
    expect(config.readiness.blockers).toContain(
      "Bounded auto-publish requires live mode, the durable ledger, and at least one ready X or Discord broadcast channel.",
    );
    expect(config.readiness.blockers).toContain(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
  });

  it("requires both independent X reply attestations and keeps them off by default", () => {
    const approvalOnly = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "false",
      OPENZAPS_X_AI_REPLY_APPROVED: "true",
      X_USER_ACCESS_TOKEN: "user-token",
    });

    expect(approvalOnly.xAiReplyApproved).toBe(false);
    expect(approvalOnly.xAutomatedLabelConfirmed).toBe(false);
    expect(approvalOnly.readiness.blockers).toContain(
      "AI-authored X replies require OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=true.",
    );

    const enabled = readMarketingConfig({
      OPENZAPS_X_AI_REPLY_APPROVED: "true",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_USER_ACCESS_TOKEN: "user-token",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
    });
    expect(enabled.xAiReplyApproved).toBe(true);
    expect(enabled.xAutomatedLabelConfirmed).toBe(true);
  });

  it("matches X readiness to OAuth2 or complete OAuth 1.0a user-context credentials", () => {
    const oauthClientOnly = readMarketingConfig({
      X_CLIENT_ID: "client",
      X_CLIENT_SECRET: "secret",
      X_REFRESH_TOKEN: "refresh",
      X_ACCESS_TOKEN: "wrong-env-name",
    });
    expect(oauthClientOnly.readiness.channels.x).toBe(false);

    expect(readMarketingConfig({
      X_USER_ACCESS_TOKEN: "user-token",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
    }).readiness.channels.x).toBe(true);
    expect(readMarketingConfig({ X_USER_ACCESS_TOKEN: " \nuser-token" }).readiness.channels.x).toBe(false);

    const oauth1 = readMarketingConfig({
      X_CONSUMER_KEY: "consumer",
      X_CONSUMER_SECRET: "consumer-secret",
      X_ACCESS_TOKEN: "access",
      X_ACCESS_TOKEN_SECRET: "access-secret",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
    });
    expect(oauth1.readiness.channels.x).toBe(true);
    expect(oauth1.readiness.configurationValid).toBe(true);
    expect(JSON.stringify(oauth1)).not.toContain("consumer-secret");

    const partial = readMarketingConfig({
      X_CONSUMER_KEY: "consumer",
      X_USER_ACCESS_TOKEN: "fallback-token",
    });
    expect(partial.readiness.configurationValid).toBe(false);
    expect(partial.readiness.blockers).toContain(
      "X OAuth 1.0a requires X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET together.",
    );
  });

  it("keeps every X provider write blocked until the automated label is confirmed", () => {
    const config = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
      X_USER_ACCESS_TOKEN: "user-token",
    });

    expect(config.readiness.canDraft).toBe(true);
    expect(config.readiness.channels.x).toBe(false);
    expect(config.readiness.blockers).toContain(
      "X publishing requires OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=true.",
    );
  });

  it("binds X readiness to an exact expected account id and canonical username", () => {
    const missing = readMarketingConfig({
      X_USER_ACCESS_TOKEN: "user-token",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
    });
    expect(missing.readiness.channels.x).toBe(false);
    expect(missing.readiness.configurationValid).toBe(true);
    expect(missing.readiness.blockers).toContain(
      "X publishing requires valid X_EXPECTED_ACCOUNT_ID and X_EXPECTED_USERNAME identity bindings.",
    );

    for (const environment of [
      {
        X_EXPECTED_ACCOUNT_ID: "100x",
        X_EXPECTED_USERNAME: "0xzaps",
      },
      {
        X_EXPECTED_ACCOUNT_ID: "100",
        X_EXPECTED_USERNAME: "@0xzaps",
      },
      {
        X_EXPECTED_ACCOUNT_ID: "100",
        X_EXPECTED_USERNAME: "OpenZaps",
      },
    ]) {
      const invalid = readMarketingConfig({
        X_USER_ACCESS_TOKEN: "user-token",
        OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
        ...environment,
      });
      expect(invalid.readiness.channels.x).toBe(false);
      expect(invalid.readiness.configurationValid).toBe(false);
    }

    const ready = readMarketingConfig({
      X_USER_ACCESS_TOKEN: "user-token",
      OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED: "true",
      X_EXPECTED_ACCOUNT_ID: "100",
      X_EXPECTED_USERNAME: "0xzaps",
    });
    expect(ready.readiness.channels.x).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("user-token");
  });

  it("accepts either implemented Discord outbound transport and requires bound interaction ids", () => {
    const webhook = readMarketingConfig({
      DISCORD_MARKETING_WEBHOOK_URL: "https://discord.com/api/v10/webhooks/123/token",
      OPENZAPS_DISCORD_GUILD_ID: "456",
      DISCORD_MARKETING_CHANNEL_ID: "789",
    });
    expect(webhook.readiness.channels.discordBroadcast).toBe(true);
    expect(
      readMarketingConfig({
        DISCORD_MARKETING_WEBHOOK_URL:
          "https://discord.com/api/v10/webhooks/123/token",
      }).readiness.channels.discordBroadcast,
    ).toBe(false);

    const bot = readMarketingConfig({
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_MARKETING_CHANNEL_ID: "123456789",
      OPENZAPS_DISCORD_GUILD_ID: "456",
    });
    expect(bot.readiness.channels.discordBroadcast).toBe(true);

    expect(
      readMarketingConfig({
        DISCORD_MARKETING_WEBHOOK_URL: "https://evil.example/api/webhooks/123/token",
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_MARKETING_CHANNEL_ID: "123456789",
        OPENZAPS_DISCORD_GUILD_ID: "456",
      }).readiness.channels.discordBroadcast,
    ).toBe(false);
    expect(
      readMarketingConfig({
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_MARKETING_CHANNEL_ID: " 123456789 ",
        OPENZAPS_DISCORD_GUILD_ID: "456",
      }).readiness.channels.discordBroadcast,
    ).toBe(false);
    expect(
      readMarketingConfig({
        DISCORD_APPLICATION_PUBLIC_KEY: "ab".repeat(32),
        OPENZAPS_DISCORD_APPLICATION_ID: "123",
        OPENZAPS_DISCORD_GUILD_ID: "456",
      }).readiness.channels.discordInteractions,
    ).toBe(true);
    expect(
      readMarketingConfig({
        DISCORD_APPLICATION_PUBLIC_KEY: "ab".repeat(32),
      }).readiness.channels.discordInteractions,
    ).toBe(false);
    expect(
      readMarketingConfig({
        DISCORD_APPLICATION_PUBLIC_KEY: "ab".repeat(32),
        OPENZAPS_DISCORD_APPLICATION_ID: "not-an-id",
        OPENZAPS_DISCORD_GUILD_ID: "456",
      }).readiness.channels.discordInteractions,
    ).toBe(false);
    expect(
      readMarketingConfig({ DISCORD_APPLICATION_PUBLIC_KEY: "not-a-key" }).readiness.channels
        .discordInteractions,
    ).toBe(false);
    expect(
      readMarketingConfig({ DISCORD_APPLICATION_PUBLIC_KEY: ` ${"ab".repeat(32)} ` }).readiness.channels
        .discordInteractions,
    ).toBe(false);
  });

  it("rejects invalid or public-equivalent Discord review webhooks without exposing credentials", () => {
    const invalid = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
      DISCORD_MARKETING_REVIEW_WEBHOOK_URL:
        "https://example.com/api/webhooks/123/private-review-token",
    });
    expect(invalid.readiness.configurationValid).toBe(false);
    expect(invalid.readiness.canDraft).toBe(false);
    expect(invalid.readiness.blockers).toContain(
      "DISCORD_MARKETING_REVIEW_WEBHOOK_URL must be a valid Discord webhook URL.",
    );
    expect(JSON.stringify(invalid)).not.toContain("private-review-token");
    expect(JSON.stringify(invalid)).not.toContain("example.com");

    const aliasedDuplicate = readMarketingConfig({
      OPENZAPS_MARKETING_ENABLED: "true",
      OPENZAPS_MARKETING_DRY_RUN: "true",
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/v10/webhooks/123/public-token?wait=true",
      DISCORD_MARKETING_REVIEW_WEBHOOK_URL:
        "https://discordapp.com/api/v9/webhooks/123/rotated-token",
      OPENZAPS_DISCORD_GUILD_ID: "789",
      DISCORD_MARKETING_CHANNEL_ID: "456",
      DISCORD_MARKETING_REVIEW_CHANNEL_ID: "101112",
    });
    expect(aliasedDuplicate.readiness.configurationValid).toBe(false);
    expect(aliasedDuplicate.readiness.canDraft).toBe(false);
    expect(aliasedDuplicate.readiness.blockers).toContain(
      "DISCORD_MARKETING_REVIEW_WEBHOOK_URL must identify a different Discord webhook from DISCORD_MARKETING_WEBHOOK_URL.",
    );
    expect(JSON.stringify(aliasedDuplicate)).not.toContain("public-token");
    expect(JSON.stringify(aliasedDuplicate)).not.toContain("rotated-token");

    const separate = readMarketingConfig({
      DISCORD_MARKETING_WEBHOOK_URL:
        "https://discord.com/api/v10/webhooks/123/public-token",
      DISCORD_MARKETING_REVIEW_WEBHOOK_URL:
        "https://discordapp.com/api/webhooks/456/private-token",
      OPENZAPS_DISCORD_GUILD_ID: "789",
      DISCORD_MARKETING_CHANNEL_ID: "101112",
      DISCORD_MARKETING_REVIEW_CHANNEL_ID: "131415",
    });
    expect(separate.readiness.configurationValid).toBe(true);

    const missingReviewBinding = readMarketingConfig({
      DISCORD_MARKETING_REVIEW_WEBHOOK_URL:
        "https://discord.com/api/webhooks/456/private-token",
      OPENZAPS_DISCORD_GUILD_ID: "789",
    });
    expect(missingReviewBinding.readiness.configurationValid).toBe(false);
    expect(missingReviewBinding.readiness.blockers).toContain(
      "DISCORD_MARKETING_REVIEW_CHANNEL_ID must be a numeric Discord channel id when the review webhook is configured.",
    );
  });
});
