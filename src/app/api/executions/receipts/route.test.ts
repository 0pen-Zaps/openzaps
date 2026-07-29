import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/relay-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-server")>()),
  relayConfigured: () => true,
}));

import { POST } from "./route";

function streamedReceiptRequest(chunks: string[]): NextRequest {
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
  const request = new Request("https://0xzaps.com/api/executions/receipts", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.61" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return new NextRequest(request);
}

describe("execution receipt POST body admission", () => {
  it("rejects an oversized declared length before verification", async () => {
    const response = await POST(new NextRequest(
      "https://0xzaps.com/api/executions/receipts",
      {
        method: "POST",
        headers: {
          "content-length": "2049",
          "x-forwarded-for": "203.0.113.62",
        },
        body: "{}",
      },
    ));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Body too large." });
  });

  it("rejects encoded bytes that exceed the cap even when string length does not", async () => {
    const body = JSON.stringify({ padding: "💥".repeat(512) });
    expect(body.length).toBeLessThanOrEqual(2_048);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_048);

    const response = await POST(new NextRequest(
      "https://0xzaps.com/api/executions/receipts",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.63" },
        body,
      },
    ));

    expect(response.status).toBe(413);
  });

  it("caps cumulative streamed chunks before parsing or chain reads", async () => {
    const response = await POST(streamedReceiptRequest([
      "{\"padding\":\"",
      "x".repeat(2_048),
      "\"}",
    ]));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Body too large." });
  });
});
