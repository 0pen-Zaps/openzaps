import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/status", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("marketing status route", () => {
  it("requires the operator bearer token and fails closed without configuration", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "");

    const response = GET(request("anything"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });

  it("returns readiness without returning provider or operator secrets", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    vi.stubEnv("OPENZAPS_MARKETING_ENABLED", "true");
    vi.stubEnv("OPENZAPS_MARKETING_DRY_RUN", "true");
    vi.stubEnv("OPENZAPS_X_AUTOMATED_LABEL_CONFIRMED", "true");
    vi.stubEnv("X_USER_ACCESS_TOKEN", "x-provider-secret");
    vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
    vi.stubEnv("X_EXPECTED_USERNAME", "0xzaps");
    vi.stubEnv(
      "DISCORD_MARKETING_WEBHOOK_URL",
      "https://discord.com/api/webhooks/123/discord-provider-secret",
    );
    vi.stubEnv("OPENZAPS_DISCORD_GUILD_ID", "456");
    vi.stubEnv("DISCORD_MARKETING_CHANNEL_ID", "789");

    const response = GET(request("operator-secret"));
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      config: { readiness: { channels: { x: boolean; discordBroadcast: boolean } } };
      policy: { xReplyScope: string };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.config.readiness.channels).toMatchObject({
      x: true,
      discordBroadcast: true,
    });
    expect(body.policy.xReplyScope).toMatch(/^operator-selected canonical status URLs/u);
    expect(raw).not.toContain("operator-secret");
    expect(raw).not.toContain("x-provider-secret");
    expect(raw).not.toContain("discord-provider-secret");
  });
});
