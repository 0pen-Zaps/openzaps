import { describe, expect, it } from "vitest";

import { leadFingerprint } from "@/lib/leads/fingerprint";

const SECRET = "s".repeat(32);

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("leadFingerprint", () => {
  it("is deterministic, non-reversible, and deployment-specific", () => {
    const requestHeaders = headers({
      "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    const first = leadFingerprint(requestHeaders, SECRET);
    const second = leadFingerprint(requestHeaders, SECRET);
    const anotherDeployment = leadFingerprint(requestHeaders, "t".repeat(32));

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain("203.0.113.9");
    expect(anotherDeployment).not.toBe(first);
  });

  it("does not trust caller-controlled x-forwarded-for", () => {
    const spoofed = leadFingerprint(
      headers({ "x-forwarded-for": "203.0.113.20" }),
      SECRET,
    );
    const absent = leadFingerprint(headers({}), SECRET);

    expect(spoofed).toBe(absent);
  });

  it("uses x-real-ip only when the Vercel forwarding header is absent", () => {
    const real = leadFingerprint(
      headers({ "x-real-ip": "2001:db8::1" }),
      SECRET,
    );
    const vercelWins = leadFingerprint(
      headers({
        "x-vercel-forwarded-for": "203.0.113.21",
        "x-real-ip": "2001:db8::1",
      }),
      SECRET,
    );

    expect(real).not.toBe(vercelWins);
  });
});
