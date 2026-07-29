import { test } from "node:test";
import assert from "node:assert/strict";

import { deliverOperationalNotification } from "./notifications.mjs";

const EVENT = {
  status: "underfunded",
  zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
  kind: "recurring",
  nonce: "1",
  txHash: null,
  detail: "capsule balance is empty",
};

const TARGETS = {
  notificationWebhookUrl: "https://hooks.example/openzaps",
  discordWebhookUrl: "https://discord.com/api/webhooks/1/token",
  telegramBotToken: "123:token",
  telegramChatId: "456",
  notificationTimeoutMs: 1_000,
};

test("notifications never send in the default/local-disabled posture", async () => {
  let calls = 0;
  const result = await deliverOperationalNotification(
    EVENT,
    { ...TARGETS, notificationsEnabled: false },
    async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test("explicitly enabled delivery formats webhook, Discord, and Telegram independently", async () => {
  const calls = [];
  const result = await deliverOperationalNotification(
    EVENT,
    { ...TARGETS, notificationsEnabled: true },
    async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(result.deliveries.length, 3);
  assert.ok(result.deliveries.every((delivery) => delivery.delivered));
  assert.equal(calls[0].body.authorityScope, "none");
  assert.match(calls[1].body.content, /UNDERFUNDED/);
  assert.equal(calls[2].body.chat_id, "456");
});
