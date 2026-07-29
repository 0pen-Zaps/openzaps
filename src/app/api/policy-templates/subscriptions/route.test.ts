import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/policy-templates/subscriptions/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("policy template subscription production gate", () => {
  it("defaults anonymous subscription writes off in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_POLICY_TEMPLATE_SUBSCRIPTIONS_ENABLED", "");

    const response = await POST(new NextRequest(
      "https://0xzaps.com/api/policy-templates/subscriptions",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SUBSCRIPTIONS_DISABLED",
    });
  });
});
