// Optional operational notifications. Disabled unless BOTH NODE_ENV=production and
// OPENZAPS_NOTIFICATIONS_ENABLED=true were present when config loaded. Destinations never affect
// scheduling, signing, simulation, or submission and therefore grant no execution authority.

function httpsUrl(raw, expectedHost = null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (expectedHost && url.hostname !== expectedHost && !url.hostname.endsWith(`.${expectedHost}`)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function notificationText(event) {
  const hash = event.txHash ? ` ${event.txHash}` : "";
  return `[OpenZaps] ${event.status.toUpperCase()} ${event.kind}:${event.nonce} ${event.zap}${hash} — ${event.detail}`.slice(
    0,
    1_900,
  );
}

async function postJson(url, body, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverOperationalNotification(event, cfg, fetchImpl = fetch) {
  if (cfg.notificationsEnabled !== true) return { skipped: true, deliveries: [] };

  const targets = [];
  const generic = httpsUrl(cfg.notificationWebhookUrl);
  if (generic) {
    targets.push({
      channel: "webhook",
      send: () =>
        postJson(
          generic,
          { version: 1, source: "openzaps-executor", event, authorityScope: "none" },
          cfg.notificationTimeoutMs,
          fetchImpl,
        ),
    });
  }
  const discord = httpsUrl(cfg.discordWebhookUrl, "discord.com");
  if (discord) {
    targets.push({
      channel: "discord",
      send: () => postJson(discord, { content: notificationText(event) }, cfg.notificationTimeoutMs, fetchImpl),
    });
  }
  if (/^[0-9]+:[A-Za-z0-9_-]+$/.test(cfg.telegramBotToken) && cfg.telegramChatId) {
    const telegram = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    targets.push({
      channel: "telegram",
      send: () =>
        postJson(
          telegram,
          { chat_id: cfg.telegramChatId, text: notificationText(event), disable_web_page_preview: true },
          cfg.notificationTimeoutMs,
          fetchImpl,
        ),
    });
  }

  const deliveries = [];
  for (const target of targets) {
    try {
      await target.send();
      deliveries.push({ channel: target.channel, delivered: true });
    } catch (error) {
      deliveries.push({ channel: target.channel, delivered: false, error: error?.message ?? String(error) });
    }
  }
  return { skipped: targets.length === 0, deliveries };
}

export function operationalStatus(result) {
  if (result.outcome === "finalized") return "finalized";
  if (result.outcome === "reverted") return "reverted";
  if (result.outcome === "underfunded") return "underfunded";
  if (result.outcome === "blocked" || result.status === "blocked" || result.status === "error") return "blocked";
  if (result.status === "expired") return "expired";
  return null;
}
