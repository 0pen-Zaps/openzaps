import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchRelayIntents } from "./relay-source.mjs";

const VALID = {
  zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
  chainId: "4663",
  seriesId: "1",
  validAfter: "0",
  deadline: "1893456000",
  interval: "86400",
  maxRuns: "10",
  recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  executor: "0x0000000000000000000000000000000000000000",
  maxGas: "3000000",
  maxFeePerGas: "10000000000",
  policyHash: "0xa31514d5c136fd98877eafe2bd715ca507fa3ee28e94194d7dba75d3e0360270",
  outAsset: "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07",
  minOutPerRun: "0",
};

function page(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-length": String(Buffer.byteLength(text)) }),
    text: async () => text,
  };
}

test("relay source follows only the bounded page budget and returns a resumable cursor", async () => {
  const urls = [];
  const pages = [
    page({
      intents: [{ id: "123e4567-e89b-42d3-a456-426614174001", kind: "recurring", intent: VALID, signature: `0x${"ab".repeat(65)}` }],
      nextCursor: "next",
    }),
    page({
      intents: [{ id: "123e4567-e89b-42d3-a456-426614174002", kind: "recurring", intent: { ...VALID, seriesId: "2" }, signature: `0x${"cd".repeat(65)}` }],
      nextCursor: null,
    }),
  ];
  const result = await fetchRelayIntents("https://relay.example", undefined, async (url) => {
    urls.push(url);
    return pages.shift();
  }, { maxPages: 1, pageSize: 1, maxRows: 1 });
  assert.equal(result.ok.length, 1);
  assert.equal(result.ok[0].intent.seriesId, 1n);
  assert.equal(result.nextCursor, "next");
  assert.equal(urls.length, 1);

  const resumed = await fetchRelayIntents("https://relay.example", undefined, async (url) => {
    urls.push(url);
    return pages.shift();
  }, { cursor: result.nextCursor, maxPages: 1, pageSize: 1, maxRows: 1 });
  assert.equal(resumed.ok[0].intent.seriesId, 2n);
  assert.equal(resumed.nextCursor, null);
  assert.match(urls[1], /cursor=next/);
});

test("relay source rejects a repeating cursor", async () => {
  await assert.rejects(
    fetchRelayIntents("https://relay.example", undefined, async () =>
      page({ intents: [], nextCursor: "repeat" }),
    ),
    /repeated cursor/,
  );
});

test("relay source rejects response bodies above the byte budget", async () => {
  await assert.rejects(
    fetchRelayIntents(
      "https://relay.example",
      undefined,
      async () => page({ intents: [], nextCursor: null }),
      { maxBytes: 4 },
    ),
    /byte budget/,
  );
});

test("relay source rejects a server page that exceeds the requested row bound", async () => {
  const row = (suffix) => ({
    id: `123e4567-e89b-42d3-a456-4266141740${suffix}`,
    kind: "recurring",
    intent: VALID,
    signature: `0x${"ab".repeat(65)}`,
  });
  await assert.rejects(
    fetchRelayIntents(
      "https://relay.example",
      undefined,
      async () => page({ intents: [row("01"), row("02")], nextCursor: null }),
      { pageSize: 1, maxRows: 1 },
    ),
    /returned 2 rows for a 1 row request/,
  );
});

test("relay source rejects unbounded cursors before they enter state or a URL", async () => {
  let called = false;
  await assert.rejects(
    fetchRelayIntents(
      "https://relay.example",
      undefined,
      async () => {
        called = true;
        return page({ intents: [], nextCursor: null });
      },
      { cursor: "x".repeat(513) },
    ),
    /cursor is malformed/,
  );
  assert.equal(called, false);

  await assert.rejects(
    fetchRelayIntents(
      "https://relay.example",
      undefined,
      async () => page({ intents: [], nextCursor: "not+a+base64url" }),
    ),
    /malformed cursor/,
  );
});

test("relay source never copies an unbounded remote id into labels", async () => {
  const result = await fetchRelayIntents(
    "https://relay.example",
    undefined,
    async () =>
      page({
        intents: [{ id: "x".repeat(10_000), kind: "recurring", intent: VALID, signature: `0x${"ab".repeat(65)}` }],
        nextCursor: null,
      }),
    { maxBytes: 32 * 1024 },
  );
  assert.equal(result.ok.length, 0);
  assert.deepEqual(result.bad, [{ file: "relay:?", error: "relay row id is malformed" }]);
});
