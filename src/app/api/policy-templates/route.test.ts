import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECIPES } from "@/lib/blocks";
import { preparePolicyTemplate } from "@/lib/policy-templates";

const serverMocks = vi.hoisted(() => ({
  getPolicyTemplate: vi.fn(),
  insertPolicyTemplate: vi.fn(),
  listPolicyTemplates: vi.fn(),
  policyRegistryConfigured: vi.fn(),
  policyTemplatePublishingEnabled: vi.fn(),
  policyTemplateSubscriptionsEnabled: vi.fn(),
  verifyPolicyTemplatePublisher: vi.fn(),
}));

vi.mock("@/lib/policy-template-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policy-template-server")>()),
  ...serverMocks,
}));

import { GET, POST } from "@/app/api/policy-templates/route";

const PUBLISHER = "0x1563915e194D8CfBA1943570603F7606A3115508";
const SIGNATURE = `0x${"11".repeat(65)}`;
const chain = RECIPES[0].blocks.map(([block, params]) => ({
  block,
  params: params ?? {},
}));

beforeEach(() => {
  serverMocks.getPolicyTemplate.mockResolvedValue(null);
  serverMocks.listPolicyTemplates.mockResolvedValue({
    templates: [],
    nextCursor: null,
  });
  serverMocks.policyRegistryConfigured.mockReturnValue(true);
  serverMocks.policyTemplatePublishingEnabled.mockReturnValue(true);
  serverMocks.policyTemplateSubscriptionsEnabled.mockReturnValue(false);
  serverMocks.verifyPolicyTemplatePublisher.mockResolvedValue({
    publisher: PUBLISHER,
    signature: SIGNATURE,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("policy template production admission gate", () => {
  it("keeps public browsing available while production writes are disabled", async () => {
    serverMocks.policyRegistryConfigured.mockReturnValue(false);
    serverMocks.policyTemplatePublishingEnabled.mockReturnValue(false);

    const write = await POST(new NextRequest("https://0xzaps.com/api/policy-templates", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.90" },
      body: "{}",
    }));
    expect(write.status).toBe(503);
    expect(await write.json()).toMatchObject({ code: "PUBLISHING_DISABLED" });

    const browse = await GET(new NextRequest(
      "https://0xzaps.com/api/policy-templates",
      { headers: { "x-forwarded-for": "203.0.113.91" } },
    ));
    expect(browse.status).toBe(200);
    expect(await browse.json()).toMatchObject({
      configured: false,
      publishingEnabled: false,
      subscriptionsEnabled: false,
      templates: [],
    });
  });

  it("publishes a validated root only after wallet admission when every gate is enabled", async () => {
    const body = {
      name: "Bounded root",
      summary: "One exact reviewed route.",
      version: 1,
      parentHash: null,
      chain,
      publisher: PUBLISHER,
      publisherSignature: SIGNATURE,
    };
    const prepared = preparePolicyTemplate(body);
    const published = {
      schema: prepared.schema,
      version: prepared.version,
      parentHash: prepared.parentHash,
      name: prepared.name,
      summary: prepared.summary,
      chain: prepared.chain,
      contentHash: prepared.contentHash,
      token: prepared.token,
      compiledHash: prepared.compiledHash,
      publisher: PUBLISHER,
      createdAt: "2026-07-29T09:00:00.000Z",
      subscriptionCount: 0,
    };
    serverMocks.insertPolicyTemplate.mockResolvedValueOnce(published);

    const response = await POST(new NextRequest(
      "https://0xzaps.com/api/policy-templates",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.92" },
        body: JSON.stringify(body),
      },
    ));

    expect(response.status).toBe(201);
    expect(serverMocks.verifyPolicyTemplatePublisher).toHaveBeenCalledWith(
      prepared,
      PUBLISHER,
      SIGNATURE,
    );
    expect(serverMocks.insertPolicyTemplate).toHaveBeenCalledWith(
      prepared,
      { publisher: PUBLISHER, signature: SIGNATURE },
    );
    expect(await response.json()).toEqual({ template: published });
  });
});
