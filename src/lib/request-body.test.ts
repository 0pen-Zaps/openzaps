import { describe, expect, it, vi } from "vitest";

import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/request-body";

const LIMIT = 32;

function streamedRequest(chunks: string[], onCancel?: () => void): Request {
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
    cancel() {
      onCancel?.();
    },
  });
  return new Request("https://0xzaps.com/api/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded JSON request bodies", () => {
  it("rejects an oversized Content-Length before consuming the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const request = new Request("https://0xzaps.com/api/test", {
      method: "POST",
      headers: { "content-length": String(LIMIT + 1) },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJsonBody(request, LIMIT)).rejects.toMatchObject({
      message: "Body too large.",
      status: 413,
    } satisfies Partial<BoundedJsonBodyError>);
  });

  it("measures encoded bytes rather than JavaScript string length", async () => {
    const text = JSON.stringify({ value: "💥".repeat(8) });
    expect(text.length).toBeLessThanOrEqual(LIMIT);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(LIMIT);

    await expect(
      readBoundedJsonBody(new Request("https://0xzaps.com/api/test", {
        method: "POST",
        body: text,
      }), LIMIT),
    ).rejects.toMatchObject({ message: "Body too large.", status: 413 });
  });

  it("cancels a streamed body as soon as cumulative chunks cross the cap", async () => {
    const cancelled = vi.fn();
    const request = streamedRequest(["{\"value\":\"", "x".repeat(LIMIT), "\"}"], cancelled);

    await expect(readBoundedJsonBody(request, LIMIT)).rejects.toMatchObject({
      message: "Body too large.",
      status: 413,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("parses a valid body and classifies malformed JSON", async () => {
    await expect(
      readBoundedJsonBody(new Request("https://0xzaps.com/api/test", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }), LIMIT),
    ).resolves.toEqual({ ok: true });

    await expect(
      readBoundedJsonBody(new Request("https://0xzaps.com/api/test", {
        method: "POST",
        body: "{",
      }), LIMIT),
    ).rejects.toMatchObject({ message: "Body must be valid JSON.", status: 400 });
  });
});
