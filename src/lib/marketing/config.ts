import type {
  MarketingChannelReadiness,
  MarketingConfig,
  MarketingDailyCaps,
  MarketingDailyCounters,
} from "@/lib/marketing/types";

export const DEFAULT_MARKETING_DAILY_CAPS: Readonly<MarketingDailyCaps> = {
  xPosts: 2,
  xReplies: 10,
  discordPosts: 3,
  substackTutorials: 1,
  directMessages: 1,
};

const CAP_ENV_KEYS: Readonly<Record<keyof MarketingDailyCounters, string>> = {
  xPosts: "OPENZAPS_MARKETING_DAILY_X_POST_CAP",
  xReplies: "OPENZAPS_MARKETING_DAILY_X_REPLY_CAP",
  discordPosts: "OPENZAPS_MARKETING_DAILY_DISCORD_POST_CAP",
  substackTutorials: "OPENZAPS_MARKETING_DAILY_SUBSTACK_TUTORIAL_CAP",
  directMessages: "OPENZAPS_MARKETING_DAILY_DM_CAP",
};

const MAX_DAILY_CAP = 100;
const DISCORD_ID = /^\d{1,30}$/u;
const DISCORD_PUBLIC_KEY = /^[0-9a-f]{64}$/iu;
const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);
const X_ACCOUNT_ID = /^\d{1,30}$/u;
const X_CANONICAL_USERNAME = /^[a-z0-9_]{1,15}$/u;
const SUPABASE_PROJECT_REF =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

type Environment = Readonly<Record<string, string | undefined>>;

interface ParsedBoolean {
  value: boolean;
  error: string | null;
}

function strictBoolean(env: Environment, key: string, fallback: boolean): ParsedBoolean {
  const raw = env[key];
  if (raw === undefined) return { value: fallback, error: null };
  if (raw === "true") return { value: true, error: null };
  if (raw === "false") return { value: false, error: null };
  return { value: fallback, error: `${key} must be exactly "true" or "false".` };
}

function dailyCap(
  env: Environment,
  counter: keyof MarketingDailyCounters,
): { value: number; error: string | null } {
  const key = CAP_ENV_KEYS[counter];
  const raw = env[key];
  if (raw === undefined) return { value: DEFAULT_MARKETING_DAILY_CAPS[counter], error: null };
  if (!/^\d+$/.test(raw)) return { value: 0, error: `${key} must be an integer from 0 to ${MAX_DAILY_CAP}.` };

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_DAILY_CAP) {
    return { value: 0, error: `${key} must be an integer from 0 to ${MAX_DAILY_CAP}.` };
  }
  return { value, error: null };
}

function hasServerSecret(env: Environment, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

interface DiscordWebhookIdentity {
  id: string;
}

function discordWebhookIdentity(raw: string | undefined): DiscordWebhookIdentity | null {
  if (!raw || !raw.trim() || /[\r\n]/u.test(raw)) return null;
  try {
    const url = new URL(raw.trim());
    const match = url.pathname.match(
      /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)$/u,
    );
    if (
      url.protocol === "https:" &&
      DISCORD_WEBHOOK_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      match
    ) {
      return { id: match[1] };
    }
    return null;
  } catch {
    return null;
  }
}

function hasDiscordWebhook(env: Environment): boolean {
  return discordWebhookIdentity(env.DISCORD_MARKETING_WEBHOOK_URL) !== null;
}

function discordWebhookIdentitiesMatch(
  first: DiscordWebhookIdentity,
  second: DiscordWebhookIdentity,
): boolean {
  return first.id === second.id;
}

function hasDiscordBot(env: Environment): boolean {
  return (
    hasServerSecret(env, "DISCORD_BOT_TOKEN") &&
    DISCORD_ID.test(env.DISCORD_MARKETING_CHANNEL_ID ?? "")
  );
}

export function isMarketingLedgerSupabaseUrl(
  raw: string | undefined,
  expectedProjectRef?: string,
  allowLoopback = true,
): boolean {
  if (!raw || raw !== raw.trim()) return false;
  try {
    const url = new URL(raw);
    const localHttp =
      allowLoopback &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const canonicalProject =
      url.protocol === "https:" &&
      !url.port &&
      typeof expectedProjectRef === "string" &&
      SUPABASE_PROJECT_REF.test(expectedProjectRef) &&
      url.hostname === `${expectedProjectRef}.supabase.co`;
    return (
      (canonicalProject || localHttp) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

/**
 * Read marketing configuration without retaining any secret value.
 *
 * Missing flags keep the agent disabled and in dry-run mode. Invalid values
 * make the whole configuration unready instead of silently widening authority.
 */
export function readMarketingConfig(env: Environment = process.env): MarketingConfig {
  const enabled = strictBoolean(env, "OPENZAPS_MARKETING_ENABLED", false);
  const dryRun = strictBoolean(env, "OPENZAPS_MARKETING_DRY_RUN", true);
  const autoPublishRequested = strictBoolean(env, "OPENZAPS_MARKETING_AUTO_PUBLISH", false);
  const durableLedgerRequested = strictBoolean(
    env,
    "OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED",
    false,
  );
  const xAiReplyApprovalRequested = strictBoolean(
    env,
    "OPENZAPS_X_AI_REPLY_APPROVED",
    false,
  );
  const xAutomatedLabelConfirmed = strictBoolean(
    env,
    "OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED",
    false,
  );
  const directMessagesEnabled = strictBoolean(env, "OPENZAPS_MARKETING_DM_ENABLED", false);

  const capEntries = (Object.keys(CAP_ENV_KEYS) as Array<keyof MarketingDailyCounters>).map(
    (counter) => [counter, dailyCap(env, counter)] as const,
  );
  const parsedCaps = Object.fromEntries(capEntries.map(([counter, parsed]) => [counter, parsed.value]));
  const dailyCaps: MarketingDailyCaps = {
    xPosts: parsedCaps.xPosts,
    xReplies: parsedCaps.xReplies,
    discordPosts: parsedCaps.discordPosts,
    substackTutorials: parsedCaps.substackTutorials,
    directMessages: parsedCaps.directMessages,
  };

  const errors = [
    enabled.error,
    dryRun.error,
    autoPublishRequested.error,
    durableLedgerRequested.error,
    xAiReplyApprovalRequested.error,
    xAutomatedLabelConfirmed.error,
    directMessagesEnabled.error,
    ...capEntries.map(([, parsed]) => parsed.error),
  ].filter((error): error is string => error !== null);

  const xOAuth1Keys = [
    "X_CONSUMER_KEY",
    "X_CONSUMER_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
  ] as const;
  const xOAuth1Presence = xOAuth1Keys.map((key) => hasServerSecret(env, key));
  const xOAuth1Complete = xOAuth1Presence.every(Boolean);
  const xOAuth1Partial = xOAuth1Presence.some(Boolean) && !xOAuth1Complete;
  if (xOAuth1Partial) {
    errors.push(
      "X OAuth 1.0a requires X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET together.",
    );
  }
  const xUserAccessToken = hasServerSecret(env, "X_USER_ACCESS_TOKEN");
  const xExpectedAccountId = env.X_EXPECTED_ACCOUNT_ID;
  const xExpectedUsername = env.X_EXPECTED_USERNAME;
  const xExpectedAccountIdValid =
    typeof xExpectedAccountId === "string"
    && X_ACCOUNT_ID.test(xExpectedAccountId);
  const xExpectedUsernameValid =
    typeof xExpectedUsername === "string"
    && X_CANONICAL_USERNAME.test(xExpectedUsername);
  if (xExpectedAccountId !== undefined && !xExpectedAccountIdValid) {
    errors.push(
      "X_EXPECTED_ACCOUNT_ID must be an exact 1-30 digit X account id.",
    );
  }
  if (xExpectedUsername !== undefined && !xExpectedUsernameValid) {
    errors.push(
      "X_EXPECTED_USERNAME must be a lowercase X username without @.",
    );
  }
  const publicDiscordWebhook = discordWebhookIdentity(
    env.DISCORD_MARKETING_WEBHOOK_URL,
  );
  const reviewDiscordWebhook = discordWebhookIdentity(
    env.DISCORD_MARKETING_REVIEW_WEBHOOK_URL,
  );
  const discordGuildIdConfigured =
    DISCORD_ID.test(env.OPENZAPS_DISCORD_GUILD_ID ?? "");
  const discordPublicChannelIdConfigured =
    DISCORD_ID.test(env.DISCORD_MARKETING_CHANNEL_ID ?? "");
  const discordReviewChannelIdConfigured =
    DISCORD_ID.test(env.DISCORD_MARKETING_REVIEW_CHANNEL_ID ?? "");
  if (
    env.DISCORD_MARKETING_REVIEW_WEBHOOK_URL !== undefined &&
    !reviewDiscordWebhook
  ) {
    errors.push(
      "DISCORD_MARKETING_REVIEW_WEBHOOK_URL must be a valid Discord webhook URL.",
    );
  } else if (
    publicDiscordWebhook &&
    reviewDiscordWebhook &&
    discordWebhookIdentitiesMatch(publicDiscordWebhook, reviewDiscordWebhook)
  ) {
    errors.push(
      "DISCORD_MARKETING_REVIEW_WEBHOOK_URL must identify a different Discord webhook from DISCORD_MARKETING_WEBHOOK_URL.",
    );
  }
  if (reviewDiscordWebhook && !discordReviewChannelIdConfigured) {
    errors.push(
      "DISCORD_MARKETING_REVIEW_CHANNEL_ID must be a numeric Discord channel id when the review webhook is configured.",
    );
  }
  if (reviewDiscordWebhook && !discordGuildIdConfigured) {
    errors.push(
      "OPENZAPS_DISCORD_GUILD_ID must be a numeric Discord guild id when the review webhook is configured.",
    );
  }
  const xIdentityConfigured =
    xExpectedAccountIdValid && xExpectedUsernameValid;
  const expectedSupabaseProjectRef =
    env.OPENZAPS_MARKETING_SUPABASE_PROJECT_REF;
  const expectedSupabaseProjectRefValid =
    typeof expectedSupabaseProjectRef === "string"
    && SUPABASE_PROJECT_REF.test(expectedSupabaseProjectRef);
  if (
    expectedSupabaseProjectRef !== undefined
    && !expectedSupabaseProjectRefValid
  ) {
    errors.push(
      "OPENZAPS_MARKETING_SUPABASE_PROJECT_REF must be an exact lowercase Supabase project ref.",
    );
  }
  // postDiscordMessage gives a configured webhook precedence. Mirror that
  // exactly: an invalid webhook must not be masked by otherwise valid bot env.
  const discordBroadcast =
    discordGuildIdConfigured &&
    discordPublicChannelIdConfigured &&
    (env.DISCORD_MARKETING_WEBHOOK_URL
      ? hasDiscordWebhook(env)
      : hasDiscordBot(env));
  const channels: MarketingChannelReadiness = {
    x:
      (xOAuth1Complete || xUserAccessToken)
      && xAutomatedLabelConfirmed.value
      && xIdentityConfigured,
    discordBroadcast,
    discordInteractions:
      DISCORD_PUBLIC_KEY.test(env.DISCORD_APPLICATION_PUBLIC_KEY ?? "") &&
      DISCORD_ID.test(env.OPENZAPS_DISCORD_APPLICATION_ID ?? "") &&
      discordGuildIdConfigured,
    directMessages: false,
    substackDirectPublish: false,
    substackManualHandoff: true,
    farcaster: false,
    github: false,
  };

  const configurationValid = errors.length === 0;
  const blockers = [...errors];
  if (!enabled.value) blockers.push("OPENZAPS_MARKETING_ENABLED is not true.");
  const ledgerCredentialsConfigured =
    isMarketingLedgerSupabaseUrl(
      env.SUPABASE_URL,
      expectedSupabaseProjectRefValid
        ? expectedSupabaseProjectRef
        : undefined,
      env.NODE_ENV !== "production",
    ) &&
    hasServerSecret(env, "SUPABASE_SERVICE_ROLE_KEY");
  const durableLedgerConfigured =
    durableLedgerRequested.value && ledgerCredentialsConfigured;
  const liveLedgerMissing =
    !dryRun.value && !durableLedgerConfigured;
  if (durableLedgerRequested.value && !ledgerCredentialsConfigured) {
    blockers.push(
      "The durable marketing ledger requires the exact bound Supabase project URL, OPENZAPS_MARKETING_SUPABASE_PROJECT_REF, and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  if (liveLedgerMissing) {
    blockers.push(
      "Non-dry-run marketing drafting requires the durable marketing ledger.",
    );
  }
  if (directMessagesEnabled.value) {
    blockers.push(
      "Direct-message delivery is not available in this release; keep OPENZAPS_MARKETING_DM_ENABLED=false.",
    );
  }
  if (
    xAiReplyApprovalRequested.value
    && !xAutomatedLabelConfirmed.value
  ) {
    blockers.push(
      "AI-authored X replies require OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=true.",
    );
  }
  if (
    (xOAuth1Complete || xUserAccessToken)
    && !xAutomatedLabelConfirmed.value
  ) {
    blockers.push(
      "X publishing requires OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED=true.",
    );
  }
  if (
    (xOAuth1Complete || xUserAccessToken)
    && !xIdentityConfigured
  ) {
    blockers.push(
      "X publishing requires valid X_EXPECTED_ACCOUNT_ID and X_EXPECTED_USERNAME identity bindings.",
    );
  }

  const xAiReplyApproved =
    xAiReplyApprovalRequested.value && xAutomatedLabelConfirmed.value;

  const autoPublishReady =
    enabled.value &&
    configurationValid &&
    !dryRun.value &&
    durableLedgerConfigured &&
    (channels.discordBroadcast || channels.x);
  const autoPublish =
    autoPublishRequested.value && autoPublishReady;
  if (autoPublishRequested.value && !autoPublishReady) {
    blockers.push(
      "Bounded auto-publish requires live mode, the durable ledger, and at least one ready X or Discord broadcast channel.",
    );
  }

  const mode = !enabled.value
    ? "disabled"
    : dryRun.value
      ? "dry_run"
      : autoPublish
        ? "live"
        : "review_only";

  return {
    enabled: enabled.value,
    dryRun: dryRun.value,
    autoPublishRequested: autoPublishRequested.value,
    autoPublish,
    xAiReplyApproved,
    xAutomatedLabelConfirmed: xAutomatedLabelConfirmed.value,
    mode,
    dailyCaps,
    readiness: {
      configurationValid,
      canDraft:
        enabled.value &&
        configurationValid &&
        (dryRun.value || durableLedgerConfigured),
      durableLedgerConfigured,
      autoPublishReady,
      channels,
      blockers,
    },
  };
}
