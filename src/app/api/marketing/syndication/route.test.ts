import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  claimMock,
  attachMock,
  failMock,
  getRunMock,
  listMock,
  readConfigMock,
  skipMock,
  startMock,
  syncMock,
  workflowMock,
} = vi.hoisted(() => ({
  claimMock: vi.fn(),
  attachMock: vi.fn(),
  failMock: vi.fn(),
  getRunMock: vi.fn(),
  listMock: vi.fn(),
  readConfigMock: vi.fn(),
  skipMock: vi.fn(),
  startMock: vi.fn(),
  syncMock: vi.fn(),
  workflowMock: vi.fn(),
}));

vi.mock("workflow/api", () => ({ getRun: getRunMock, start: startMock }));
vi.mock("@/lib/marketing/config", () => ({ readMarketingConfig: readConfigMock }));
vi.mock("@/lib/marketing/syndication-server", () => ({
  attachMarketingSyndicationWorkflow: attachMock,
  claimMarketingSyndicationDraft: claimMock,
  failMarketingSyndicationDraft: failMock,
  listMarketingSyndicationItems: listMock,
  skipMarketingSyndicationItem: skipMock,
  syncMarketingSyndicationStatus: syncMock,
}));
vi.mock("@/workflows/marketing-agent/contracts", () => ({
  marketingBodyContainsExactUrl: (body: string, requiredUrl: string) =>
    (body.match(/https:\/\/[^\s<>"']+/gu) ?? []).some(
      (candidate) =>
        candidate.replace(/[\])}>.,!?;:]+$/gu, "") === requiredUrl,
    ),
  reviewMarketingDeliveryIdempotencyKey: (bundleId: string, channel: string) =>
    `${bundleId.replace(/[^A-Za-z0-9._:-]/gu, "_")}:${channel}`,
  MarketingRunEventSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
  MarketingWorkflowResultSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
}));
vi.mock("@/workflows/marketing-agent", () => ({
  openZapsMarketingWorkflow: workflowMock,
}));

import { GET, POST } from "./route";
import {
  createMarketingSyndicationRepairProof,
  verifyMarketingSyndicationRepairProof,
} from "@/lib/marketing/auth";

const ITEM_ID = "a".repeat(64);
const NOW = "2026-08-01T12:00:00.000Z";

function item(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM_ID,
    source: "openzaps",
    title: "A bounded product update",
    canonicalUrl: "https://www.0xzaps.com/virtual-trading",
    publishedAt: "2026-07-30T12:01:00.000Z",
    classification: "reviewable",
    status: "pending",
    campaignSlug: "openzaps-virtual-trading-2026-07-30",
    workflowRunId: null,
    discoveredAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function attributedLinks(value = item()) {
  const x = new URL(value.canonicalUrl);
  x.searchParams.set("utm_source", "x");
  x.searchParams.set("utm_medium", "social");
  x.searchParams.set("utm_campaign", value.campaignSlug);
  x.searchParams.set("utm_content", "feed_update");
  const discord = new URL(value.canonicalUrl);
  discord.searchParams.set("utm_source", "discord");
  discord.searchParams.set("utm_medium", "community");
  discord.searchParams.set("utm_campaign", value.campaignSlug);
  discord.searchParams.set("utm_content", "feed_update");
  return { x: x.toString(), discord: discord.toString() };
}

function boundDraft(value = item(), runId = "wrun_syndication_1") {
  const links = attributedLinks(value);
  const kind = value.source === "defitutorials" ? "tutorial" : "product_update";
  return {
    id: "draft:syndication",
    runId,
    request: {
      kind,
      channels: ["x", "discord"],
      sourceUrls: [value.canonicalUrl],
      requiredChannelLinks: links,
    },
    candidates: [
      {
        id: "candidate-x",
        channel: "x",
        kind,
        action: "broadcast",
        body: `Reviewed update ${links.x}`,
        links: [links.x],
      },
      {
        id: "candidate-discord",
        channel: "discord",
        kind,
        action: "broadcast",
        body: `Reviewed update ${links.discord}`,
        links: [links.discord],
      },
    ],
  };
}

function publishedResult(value = item(), runId = "wrun_syndication_1") {
  return {
    runId,
    status: "published",
    draft: boundDraft(value, runId),
    approval: { decision: "approve" },
    deliveries: [
      {
        channel: "x",
        candidateId: "candidate-x",
        status: "published",
        idempotencyKey: "draft:syndication:x",
        providerMessageId: "2000000000000000001",
        providerUrl:
          "https://x.com/i/web/status/2000000000000000001",
      },
      {
        channel: "discord",
        candidateId: "candidate-discord",
        status: "published",
        idempotencyKey: "draft:syndication:discord",
        providerMessageId: "2000000000000000002",
      },
    ],
  };
}

function request(method = "GET", body?: unknown, token = "operator-token"): Request {
  return new Request("https://www.0xzaps.com/api/marketing/syndication", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function readable(events: unknown[]) {
  let index = 0;
  return {
    getTailIndex: vi.fn().mockResolvedValue(events.length - 1),
    getReader: vi.fn(() => ({
      read: vi.fn(async () => index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })),
  };
}

function run(events: unknown[], options: {
  status?: string;
  result?: unknown;
  exists?: boolean;
} = {}) {
  return {
    exists: Promise.resolve(options.exists ?? true),
    status: Promise.resolve(options.status ?? "running"),
    returnValue: Promise.resolve(options.result),
    getReadable: vi.fn(() => readable(events)),
  };
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-repair-secret");
  readConfigMock.mockReturnValue({
    readiness: { canDraft: true, durableLedgerConfigured: true },
  });
  listMock.mockResolvedValue([item()]);
  claimMock.mockResolvedValue({ result: "claimed", item: item({ status: "drafting" }) });
  attachMock.mockResolvedValue({
    result: "attached",
    status: "drafting",
    workflowRunId: "wrun_syndication_1",
  });
  failMock.mockResolvedValue({
    result: "failed",
    status: "failed",
    workflowRunId: null,
  });
  skipMock.mockResolvedValue({
    result: "skipped",
    status: "skipped",
    workflowRunId: null,
  });
  syncMock.mockResolvedValue({
    result: "synced",
    status: "awaiting_approval",
    workflowRunId: "wrun_syndication_1",
  });
  startMock.mockResolvedValue({ runId: "wrun_syndication_1" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("marketing syndication operator route", () => {
  it("authenticates before reading the inbox or request body", async () => {
    const getResponse = await GET(request("GET", undefined, "wrong"));
    const postResponse = await POST(request("POST", "{", "wrong"));

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("lists a bounded private inbox without workflow work for pending items", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      items: [item()],
      reconciliation: { checked: 0, updated: 0, deferred: 0 },
    });
    expect(listMock).toHaveBeenCalledWith(20);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("reconciles a persisted run only from bounded workflow evidence", async () => {
    const drafting = item({
      status: "drafting",
      workflowRunId: "wrun_syndication_1",
    });
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    listMock.mockResolvedValueOnce([drafting]).mockResolvedValueOnce([awaiting]);
    getRunMock.mockReturnValue(run([{
      type: "draft",
      state: "awaiting_approval",
      draft: boundDraft(drafting),
    }]));

    const response = await GET(request());

    expect(await response.json()).toEqual({
      items: [awaiting],
      reconciliation: { checked: 1, updated: 1, deferred: 0 },
    });
    expect(syncMock).toHaveBeenCalledWith(
      ITEM_ID,
      "wrun_syndication_1",
      "awaiting_approval",
    );
  });

  it("marks publication only from an actual published delivery", async () => {
    listMock
      .mockResolvedValueOnce([item({ status: "drafting", workflowRunId: "wrun_syndication_1" })])
      .mockResolvedValueOnce([item({ status: "published", workflowRunId: "wrun_syndication_1" })]);
    const drafting = item({
      status: "drafting",
      workflowRunId: "wrun_syndication_1",
    });
    getRunMock.mockReturnValue(run(
      [{
        type: "draft",
        state: "awaiting_approval",
        draft: boundDraft(drafting),
      }],
      {
        status: "completed",
        result: publishedResult(drafting),
      },
    ));

    const response = await GET(request());
    const body = await response.json();

    expect(body.reconciliation).toEqual({ checked: 1, updated: 2, deferred: 0 });
    expect(syncMock.mock.calls).toEqual([
      [ITEM_ID, "wrun_syndication_1", "awaiting_approval"],
      [ITEM_ID, "wrun_syndication_1", "published"],
    ]);
  });

  it("fails closed when only one requested channel published", async () => {
    listMock
      .mockResolvedValueOnce([item({
        status: "awaiting_approval",
        workflowRunId: "wrun_syndication_1",
      })])
      .mockResolvedValueOnce([item({
        status: "failed",
        workflowRunId: "wrun_syndication_1",
      })]);
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    getRunMock.mockReturnValue(run([], {
      status: "completed",
      result: {
        ...publishedResult(awaiting),
        status: "partially_published",
        deliveries: [
          {
            channel: "x",
            candidateId: "candidate-x",
            status: "published",
            providerMessageId: "2000000000000000001",
          },
          {
            channel: "discord",
            candidateId: "candidate-discord",
            status: "failed",
          },
        ],
      },
    }));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(syncMock).toHaveBeenCalledWith(
      ITEM_ID,
      "wrun_syndication_1",
      "failed",
    );
  });

  it("does not infer publication from a completed status without a published receipt", async () => {
    listMock
      .mockResolvedValueOnce([item({ status: "awaiting_approval", workflowRunId: "wrun_syndication_1" })])
      .mockResolvedValueOnce([item({ status: "failed", workflowRunId: "wrun_syndication_1" })]);
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    getRunMock.mockReturnValue(run([], {
      status: "completed",
      result: { ...publishedResult(awaiting), deliveries: [] },
    }));

    await GET(request());

    expect(syncMock).toHaveBeenCalledWith(ITEM_ID, "wrun_syndication_1", "failed");
  });

  it("defers a run whose reviewed source binding does not match the inbox item", async () => {
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    listMock.mockResolvedValue([awaiting]);
    getRunMock.mockReturnValue(run([], {
      status: "completed",
      result: publishedResult({
        ...awaiting,
        canonicalUrl: "https://www.0xzaps.com/request-a-zap",
      }),
    }));

    const response = await GET(request());

    expect(await response.json()).toMatchObject({
      reconciliation: { checked: 1, updated: 0, deferred: 1 },
    });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("requires provider message ids for both published channel receipts", async () => {
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    listMock
      .mockResolvedValueOnce([awaiting])
      .mockResolvedValueOnce([item({
        status: "failed",
        workflowRunId: "wrun_syndication_1",
      })]);
    const result = publishedResult(awaiting);
    delete (result.deliveries[1] as { providerMessageId?: string })
      .providerMessageId;
    getRunMock.mockReturnValue(run([], { status: "completed", result }));

    await GET(request());

    expect(syncMock).toHaveBeenCalledWith(ITEM_ID, "wrun_syndication_1", "failed");
  });

  it.each([
    ["a mismatched X receipt URL", (result: ReturnType<typeof publishedResult>) => {
      result.deliveries[0].providerUrl =
        "https://x.com/i/web/status/2000000000000000009";
    }],
    ["an oversized X provider id", (result: ReturnType<typeof publishedResult>) => {
      result.deliveries[0].providerMessageId = "1".repeat(20);
      result.deliveries[0].providerUrl =
        `https://x.com/i/web/status/${"1".repeat(20)}`;
    }],
    ["an oversized Discord provider id", (result: ReturnType<typeof publishedResult>) => {
      result.deliveries[1].providerMessageId = "1".repeat(31);
    }],
    ["a reconstructed delivery idempotency key", (result: ReturnType<typeof publishedResult>) => {
      result.deliveries[1].idempotencyKey = "draft:other:discord";
    }],
  ])("does not publish from %s", async (_label, mutate) => {
    const awaiting = item({
      status: "awaiting_approval",
      workflowRunId: "wrun_syndication_1",
    });
    listMock
      .mockResolvedValueOnce([awaiting])
      .mockResolvedValueOnce([item({
        status: "failed",
        workflowRunId: "wrun_syndication_1",
      })]);
    const result = publishedResult(awaiting);
    mutate(result);
    getRunMock.mockReturnValue(run([], { status: "completed", result }));

    await GET(request());

    expect(syncMock).toHaveBeenCalledWith(
      ITEM_ID,
      "wrun_syndication_1",
      "failed",
    );
  });

  it("reports reconciliation gaps without hiding the durable inbox", async () => {
    listMock.mockResolvedValue([
      item({ status: "drafting", workflowRunId: "wrun_syndication_1" }),
    ]);
    getRunMock.mockImplementation(() => { throw new Error("secret backend failure"); });

    const response = await GET(request());
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).toContain('"deferred":1');
    expect(raw).not.toContain("secret backend failure");
  });

  it("reports a missing durable workflow as deferred", async () => {
    listMock.mockResolvedValue([
      item({ status: "drafting", workflowRunId: "wrun_syndication_1" }),
    ]);
    getRunMock.mockReturnValue(run([], { exists: false }));

    const response = await GET(request());

    expect(await response.json()).toMatchObject({
      reconciliation: { checked: 1, updated: 0, deferred: 1 },
    });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("closes a proof-bound workflow that failed before emitting a draft", async () => {
    listMock
      .mockResolvedValueOnce([item({
        status: "drafting",
        workflowRunId: "wrun_syndication_1",
      })])
      .mockResolvedValueOnce([item({
        status: "failed",
        workflowRunId: "wrun_syndication_1",
      })]);
    getRunMock.mockReturnValue(run([], { status: "failed" }));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(syncMock).toHaveBeenCalledWith(
      ITEM_ID,
      "wrun_syndication_1",
      "failed",
    );
  });

  it("rejects malformed, oversized, and non-strict actions", async () => {
    const malformed = await POST(request("POST", "{"));
    const unknown = await POST(request("POST", {
      action: "draft",
      itemId: ITEM_ID,
      extra: true,
    }));
    const oversized = await POST(new Request(
      "https://www.0xzaps.com/api/marketing/syndication",
      {
        method: "POST",
        headers: {
          authorization: "Bearer operator-token",
          "content-type": "application/json",
          "content-length": "1025",
        },
        body: "{}",
      },
    ));

    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("atomically claims, starts one review workflow, and finalizes its run id", async () => {
    const response = await POST(request("POST", { action: "draft", itemId: ITEM_ID }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      itemId: ITEM_ID,
      status: "queued",
      runId: "wrun_syndication_1",
    });
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      startMock.mock.invocationCallOrder[0],
    );
    expect(startMock).toHaveBeenCalledWith(workflowMock, [{
      kind: "product_update",
      brief: expect.stringContaining("review-only X and Discord drafts"),
      channels: ["x", "discord"],
      sourceUrls: ["https://www.0xzaps.com/virtual-trading"],
      requiredChannelLinks: {
        x: "https://www.0xzaps.com/virtual-trading?utm_source=x&utm_medium=social&utm_campaign=openzaps-virtual-trading-2026-07-30&utm_content=feed_update",
        discord: "https://www.0xzaps.com/virtual-trading?utm_source=discord&utm_medium=community&utm_campaign=openzaps-virtual-trading-2026-07-30&utm_content=feed_update",
      },
    }]);
    expect(attachMock).toHaveBeenCalledWith(ITEM_ID, "wrun_syndication_1");
  });

  it("uses tutorial classification and the exact canonical Substack URL", async () => {
    claimMock.mockResolvedValue({
      result: "claimed",
      item: item({
        source: "defitutorials",
        canonicalUrl: "https://defitutorials.substack.com/p/bounded-zaps",
        campaignSlug: "defitutorials-paper-trade-first-authority-map",
        status: "drafting",
      }),
    });

    await POST(request("POST", { action: "draft", itemId: ITEM_ID }));

    expect(startMock.mock.calls[0]?.[1]?.[0]).toMatchObject({
      kind: "tutorial",
      channels: ["x", "discord"],
      sourceUrls: ["https://defitutorials.substack.com/p/bounded-zaps"],
      requiredChannelLinks: {
        x: expect.stringContaining("utm_source=x"),
        discord: expect.stringContaining("utm_source=discord"),
      },
    });
  });

  it("replays a completed claim without starting a duplicate workflow", async () => {
    claimMock.mockResolvedValue({
      result: "already_drafted",
      item: item({
        status: "awaiting_approval",
        workflowRunId: "wrun_existing",
      }),
    });

    const response = await POST(request("POST", { action: "draft", itemId: ITEM_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "already_queued",
      runId: "wrun_existing",
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("fails an ambiguous start terminally and never retries it in the route", async () => {
    startMock.mockRejectedValue(new Error("provider secret should-never-leak"));

    const response = await POST(request("POST", { action: "draft", itemId: ITEM_ID }));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(failMock).toHaveBeenCalledWith(ITEM_ID);
    expect(attachMock).not.toHaveBeenCalled();
    expect(raw).toContain("will not be retried automatically");
    expect(raw).not.toContain("should-never-leak");
  });

  it("does not mark a known-started workflow failed when finalization is uncertain", async () => {
    attachMock.mockRejectedValue(new Error("database secret should-never-leak"));

    const response = await POST(request("POST", { action: "draft", itemId: ITEM_ID }));
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(failMock).not.toHaveBeenCalled();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({ runId: "wrun_syndication_1" });
    expect(body.repairProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifyMarketingSyndicationRepairProof(
      ITEM_ID,
      "wrun_syndication_1",
      String(body.repairProof),
    )).toBe(true);
    expect(raw).toContain("workflow started");
    expect(raw).not.toContain("operator-token");
    expect(raw).not.toContain("should-never-leak");
  });

  it("repairs a known workflow link without starting another workflow", async () => {
    const repairProof = createMarketingSyndicationRepairProof(
      ITEM_ID,
      "wrun_syndication_1",
    );
    const response = await POST(request("POST", {
      action: "attach",
      itemId: ITEM_ID,
      runId: "wrun_syndication_1",
      repairProof,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      itemId: ITEM_ID,
      status: "queued",
      runId: "wrun_syndication_1",
    });
    expect(attachMock).toHaveBeenCalledWith(ITEM_ID, "wrun_syndication_1");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("rejects an attach action without the exact server-issued repair proof", async () => {
    const response = await POST(request("POST", {
      action: "attach",
      itemId: ITEM_ID,
      runId: "wrun_syndication_1",
      repairProof: "a".repeat(43),
    }));

    expect(response.status).toBe(409);
    expect(attachMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("skips only through the durable inbox mutation", async () => {
    const response = await POST(request("POST", { action: "skip", itemId: ITEM_ID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId: ITEM_ID, status: "skipped" });
    expect(skipMock).toHaveBeenCalledWith(ITEM_ID);
    expect(startMock).not.toHaveBeenCalled();
  });
});
