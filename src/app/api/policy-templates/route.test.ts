import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("policy template production admission gate", () => {
  it("keeps public browsing available while unsigned production writes default off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENZAPS_POLICY_TEMPLATE_PUBLISHING_ENABLED", "");

    const write = await POST(new NextRequest("https://0xzaps.com/api/policy-templates", {
      method: "POST",
      body: "{}",
    }));
    expect(write.status).toBe(503);
    expect(await write.json()).toMatchObject({ code: "PUBLISHING_DISABLED" });

    const browse = await GET(new NextRequest("https://0xzaps.com/api/policy-templates"));
    expect(browse.status).toBe(200);
    expect(await browse.json()).toMatchObject({
      configured: false,
      publishingEnabled: false,
      subscriptionsEnabled: false,
      templates: [],
    });
  });
});
