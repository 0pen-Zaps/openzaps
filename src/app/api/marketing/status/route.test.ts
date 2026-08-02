import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const compliance = vi.hoisted(() => ({
  configured: vi.fn(() => false),
  health: vi.fn(),
}));

vi.mock("@/lib/marketing/x-compliance-server", () => ({
  getMarketingXComplianceHealth: compliance.health,
  marketingXComplianceConfigured: compliance.configured,
}));

import { GET } from "./route";
import {
  X_MENTION_APPROVAL_REGISTRY,
  X_MENTION_TEMPLATE_REGISTRY_DIGEST,
} from "@/lib/marketing/x-mention-registry";

function request(token?: string): Request {
  return new Request("https://www.0xzaps.com/api/marketing/status", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

beforeEach(() => {
  compliance.configured.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing status route", () => {
  it("requires the operator bearer token and fails closed without configuration", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "");

    const response = await GET(request("anything"));

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
    compliance.configured.mockReturnValue(true);
    compliance.health.mockResolvedValue({
      result: "healthy",
      checkpointId: "00000000-0000-4000-8000-000000000099",
      checkedAt: "2026-08-01T15:55:00.000Z",
      validUntil: "2026-08-01T16:25:00.000Z",
      subjectCount: 3,
      nonPresentCount: 0,
      hold: false,
    });

    const response = await GET(request("operator-secret"));
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      config: { readiness: { channels: { x: boolean; discordBroadcast: boolean } } };
      xMentionAutomation: {
        ingestReady: boolean;
        hashSecretConfigured: boolean;
        canonicalUsernameBound: boolean;
        templateRegistryDigest: string;
      };
      xActivationEvidence: {
        schemaVersion: number;
        evaluatedAt: string;
        expectedAccountIdentity: { accountId: string; username: string } | null;
        privacyUrl: string;
        templates: Array<{
          templateId: string;
          prompts: string[];
          body: string;
        }>;
      };
      xComplianceHealth: {
        result: string;
        checkedAt: string;
        validUntil: string;
        subjectCount: number;
        nonPresentCount: number;
        hold: boolean;
      } | null;
      sourceControlledTutorials: Array<{
        tutorialId: string;
        hero: {
          sourcePath: string;
          sha256: string;
          mimeType: string;
          width: number;
          height: number;
          byteLength: number;
          alt: string;
        };
      }>;
      policy: { xReplyScope: string; xAutomaticReplyScope: string };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.config.readiness.channels).toMatchObject({
      x: true,
      discordBroadcast: true,
    });
    expect(body.policy.xReplyScope).toMatch(/^operator-selected canonical status URLs/u);
    expect(body.policy.xAutomaticReplyScope).toContain("official mentions timeline only");
    expect(body.xMentionAutomation).toMatchObject({
      ingestReady: false,
      hashSecretConfigured: false,
      canonicalUsernameBound: true,
      templateRegistryDigest: X_MENTION_TEMPLATE_REGISTRY_DIGEST,
    });
    expect(body.xActivationEvidence).toMatchObject({
      schemaVersion: 2,
      expectedAccountIdentity: { accountId: "100", username: "0xzaps" },
      privacyUrl: "https://www.0xzaps.com/legal#request-data",
    });
    expect(Number.isFinite(Date.parse(body.xActivationEvidence.evaluatedAt)))
      .toBe(true);
    expect(body.xActivationEvidence.templates.map(({ templateId }) => templateId))
      .toEqual([
        "about-v1",
        "agent-authority-v1",
        "docs-v1",
        "request-zap-v1",
        "virtual-trading-v1",
      ]);
    expect(body.xActivationEvidence.templates).toHaveLength(5);
    expect(body.xActivationEvidence.templates).toEqual(
      X_MENTION_APPROVAL_REGISTRY.map(({ templateId, prompts, body }) => ({
        templateId,
        prompts: [...prompts],
        body,
      })),
    );
    expect(body.xActivationEvidence.templates.every(
      ({ body: templateBody }) =>
        templateBody.length > 0 && Array.from(templateBody).length <= 280,
    )).toBe(true);
    expect(body.xActivationEvidence.templates.find(
      ({ templateId }) => templateId === "request-zap-v1",
    )?.body).toContain("https://www.0xzaps.com/request-a-zap");
    expect(body.xComplianceHealth).toEqual({
      result: "healthy",
      checkedAt: "2026-08-01T15:55:00.000Z",
      validUntil: "2026-08-01T16:25:00.000Z",
      subjectCount: 3,
      nonPresentCount: 0,
      hold: false,
    });
    expect(body.sourceControlledTutorials).toEqual([
      expect.objectContaining({
        tutorialId: "paper-trade-first-authority-map",
        hero: {
          sourcePath: "docs/media/12-virtual-trading.jpg",
          sha256:
            "4dbb4a595012baaef3541e284770e7ffad3bc671b4ba3fc95672cc33f2abc120",
          mimeType: "image/jpeg",
          width: 1128,
          height: 440,
          byteLength: 49_900,
          alt:
            "OpenZaps Virtual Trading banner reading \"Trade the route. Risk nothing.\" beside a wallet-free paper-trading safety checklist.",
        },
      }),
      expect.objectContaining({
        tutorialId: "earn-pool-fees-not-emissions",
        hero: {
          sourcePath: "docs/media/13-fee-rewards-campaign.jpg",
          sha256:
            "4d0e4710ceec2acd26f1d52f12941fe0d125428f1156d592a86720916ff841b0",
          mimeType: "image/jpeg",
          width: 1128,
          height: 440,
          byteLength: 109_242,
          alt:
            "The OpenZaps fee rewards page reading \"Stake 0xZAPS. Claim WETH from the pool's trading fees.\" beside a campaign terms panel showing the seven-day window and claim deadline.",
        },
      }),
    ]);
    expect(Object.keys(body.sourceControlledTutorials[0]?.hero ?? {})).not
      .toContain("bytes");
    expect(compliance.health).toHaveBeenCalledWith("100");
    expect(raw).not.toContain("00000000-0000-4000-8000-000000000099");
    expect(raw).not.toContain("operator-secret");
    expect(raw).not.toContain("x-provider-secret");
    expect(raw).not.toContain("discord-provider-secret");
  });

  it("does not expose a partial expected identity for a noncanonical username", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
    vi.stubEnv("X_EXPECTED_USERNAME", "otheraccount");

    const response = await GET(request("operator-secret"));
    const body = await response.json() as {
      xActivationEvidence: { expectedAccountIdentity: unknown };
    };

    expect(response.status).toBe(200);
    expect(body.xActivationEvidence.expectedAccountIdentity).toBeNull();
  });

  it("fails compliance readiness closed when the durable health read fails", async () => {
    vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-secret");
    vi.stubEnv("X_EXPECTED_ACCOUNT_ID", "100");
    compliance.configured.mockReturnValue(true);
    compliance.health.mockRejectedValue(
      new Error("database response included service-role-secret"),
    );

    const response = await GET(request("operator-secret"));
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      xComplianceHealth: unknown;
      xMentionAutomation: {
        complianceHealth: string;
        complianceReady: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(body.xComplianceHealth).toBeNull();
    expect(body.xMentionAutomation).toMatchObject({
      complianceHealth: "unavailable",
      complianceReady: false,
    });
    expect(raw).not.toContain("service-role-secret");
  });
});
