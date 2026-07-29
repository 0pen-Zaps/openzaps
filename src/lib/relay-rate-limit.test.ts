import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { serverRateLimit } from "@/lib/relay-rate-limit";

function request(ip: string): NextRequest {
  return {
    headers: new Headers({
      "x-vercel-forwarded-for": `${ip}, 10.0.0.1`,
      "x-forwarded-for": "spoofed-client",
    }),
  } as NextRequest;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("server route limiter", () => {
  it("uses the platform forwarding header and returns a usable Retry-After", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const namespace = `retry-after-${Math.random()}`;
    expect(serverRateLimit(request("203.0.113.9"), namespace, 1, 10_000).limited).toBe(false);
    expect(serverRateLimit(request("203.0.113.10"), namespace, 1, 10_000).limited).toBe(false);
    expect(serverRateLimit(request("203.0.113.9"), namespace, 1, 10_000)).toEqual({
      limited: true,
      retryAfterSeconds: 10,
    });
  });
});
