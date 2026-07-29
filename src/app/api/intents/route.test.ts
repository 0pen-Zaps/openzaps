import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/relay-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-server")>()),
  relayConfigured: () => true,
}));

import { POST } from "./route";

function streamedIntentRequest(chunks: string[]): NextRequest {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  const request = new Request("https://0xzaps.com/api/intents", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.51" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return new NextRequest(request);
}

describe("intent POST body admission", () => {
  it("rejects an oversized declared length before parsing", async () => {
    const response = await POST(new NextRequest("https://0xzaps.com/api/intents", {
      method: "POST",
      headers: {
        "content-length": "16385",
        "x-forwarded-for": "203.0.113.52",
      },
      body: "{}",
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Body too large." });
  });

  it("rejects encoded bytes that exceed the cap even when string length does not", async () => {
    const body = JSON.stringify({ padding: "💥".repeat(4_096) });
    expect(body.length).toBeLessThanOrEqual(16_384);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(16_384);

    const response = await POST(new NextRequest("https://0xzaps.com/api/intents", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.53" },
      body,
    }));

    expect(response.status).toBe(413);
  });

  it("caps cumulative streamed chunks without buffering the full intent", async () => {
    const response = await POST(streamedIntentRequest([
      "{\"padding\":\"",
      "x".repeat(16_384),
      "\"}",
    ]));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Body too large." });
  });
});
