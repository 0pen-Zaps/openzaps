import assert from "node:assert/strict";
import test from "node:test";

import { appGet, boundedResponseJson } from "./config.mjs";

test("boundedResponseJson rejects a declared oversized response before reading it", async () => {
  const response = new Response(JSON.stringify({ value: "small" }), {
    headers: { "content-length": "1000", "content-type": "application/json" },
  });
  await assert.rejects(
    () => boundedResponseJson(response, 32, "test response"),
    /exceeds the 32-byte response limit/,
  );
});

test("appGet rejects a chunked response that crosses its hard byte budget", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(64)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    () => appGet({ appUrl: "https://app.example" }, "/api/test", { maxBytes: 32 }),
    /exceeds the 32-byte response limit/,
  );
});
