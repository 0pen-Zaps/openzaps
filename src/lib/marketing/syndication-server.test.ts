import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  attachMarketingSyndicationWorkflow,
  claimMarketingSyndicationDraft,
  discoverMarketingSyndication,
  failMarketingSyndicationDraft,
  listMarketingSyndicationItems,
  marketingSyndicationConfigured,
  skipMarketingSyndicationItem,
  syncMarketingSyndicationStatus,
} from "./syndication-server";

const ITEM_ID = "a".repeat(64);
const NOW = "2026-08-01T12:00:00.000Z";
const REST = "https://abcdefghijklmnopqrst.supabase.co/rest/v1/";

const ENV = {
  NODE_ENV: "production",
  OPENZAPS_MARKETING_DURABLE_LEDGER_CONFIGURED: "true",
  OPENZAPS_MARKETING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
} as const;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <guid>post-1</guid>
    <title>Give an Agent the Trigger, Never the Authority</title>
    <link>https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the</link>
    <pubDate>Wed, 29 Jul 2026 16:55:32 GMT</pubDate>
    <description>Untrusted body that must never enter the inbox.</description>
    <author>Unstored Author</author>
  </item>
</channel></rss>`;

const POISONED_TITLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <guid>post-poisoned-title</guid>
    <title>Authorization: Bearer ${"a".repeat(32)}</title>
    <link>https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the</link>
    <pubDate>Wed, 29 Jul 2026 16:55:32 GMT</pubDate>
  </item>
</channel></rss>`;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: ITEM_ID,
    source_key: "openzaps",
    canonical_url: "https://www.0xzaps.com/virtual-trading",
    title: "Practice deployed routes in Virtual Trading",
    campaign_slug: "openzaps-openzaps-virtual-trading-2026-07-30",
    source_published_at: "2026-07-30T12:01:00.000Z",
    classification: "product_update",
    state: "pending",
    workflow_run_id: null,
    discovered_at: NOW,
    state_changed_at: NOW,
    draft_claimed_at: null,
    draft_completed_at: null,
    syndicated_at: null,
    skipped_at: null,
    failed_at: null,
    ...overrides,
  };
}

function cursor(source: "openzaps" | "defitutorials", initialized: boolean) {
  return [{
    result_code: initialized ? "found" : "not_initialized",
    source_key: source,
    initialized_at: initialized ? NOW : null,
    etag: initialized && source === "defitutorials" ? '"feed-v1"' : null,
    last_modified:
      initialized && source === "defitutorials"
        ? "Sat, 01 Aug 2026 11:00:00 GMT"
        : null,
    last_checked_at: initialized ? NOW : null,
  }];
}

function discoveryRow(
  source: "openzaps" | "defitutorials",
  result: "baselined" | "discovered" | "not_modified" | "baseline_required",
  inputCount: number,
) {
  const baseline = result === "baselined";
  const unavailable = result === "baseline_required";
  return [{
    result_code: result,
    source_key: source,
    initialized_at: unavailable ? null : NOW,
    discovered_count: inputCount,
    baseline_count: baseline ? inputCount : 0,
    pending_count: result === "discovered" ? inputCount : 0,
    existing_count: 0,
    reclassified_count: 0,
    etag: source === "defitutorials" && !unavailable ? '"feed-v2"' : null,
    last_modified:
      source === "defitutorials" && !unavailable
        ? "Sat, 01 Aug 2026 12:00:00 GMT"
        : null,
    last_checked_at: unavailable ? null : NOW,
  }];
}

function rpcName(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : input.toString())
    .pathname.split("/").pop() as string;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable marketing syndication server", () => {
  it("fails closed unless the exact durable Supabase binding and secret exist", () => {
    expect(marketingSyndicationConfigured(ENV)).toBe(true);
    expect(marketingSyndicationConfigured({ ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" })).toBe(false);
    expect(marketingSyndicationConfigured({
      ...ENV,
      SUPABASE_URL: "https://wrong-project.supabase.co",
    })).toBe(false);
  });

  it("baselines both successful first snapshots and stores public metadata only", async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://defitutorials.substack.com/feed") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(new Headers(init?.headers).has("cookie")).toBe(false);
        return new Response(FEED, {
          headers: {
            etag: '"feed-v2"',
            "last-modified": "Sat, 01 Aug 2026 12:00:00 GMT",
          },
        });
      }
      const body = requestBody(init);
      if (rpcName(input) === "get_marketing_syndication_source_cursor") {
        return json(cursor(body.p_source_key as "openzaps" | "defitutorials", false));
      }
      if (rpcName(input) === "discover_marketing_syndication_items") {
        const snapshot = body.p_snapshot as Record<string, unknown>;
        snapshots.push(snapshot);
        expect(body.p_initialize_as_baseline).toBe(true);
        const items = snapshot.items as unknown[];
        return json(discoveryRow(
          snapshot.source_key as "openzaps" | "defitutorials",
          "baselined",
          items.length,
        ));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await discoverMarketingSyndication({
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      providerWritesAttempted: false,
      workflowsStarted: false,
      sources: [
        { source: "openzaps", result: "initialized" },
        { source: "defitutorials", result: "initialized" },
      ],
    });
    const tutorialSnapshot = snapshots.find(
      (snapshot) => snapshot.source_key === "defitutorials",
    );
    expect(tutorialSnapshot).toMatchObject({
      source_key: "defitutorials",
      not_modified: false,
      etag: '"feed-v2"',
      last_modified: "Sat, 01 Aug 2026 12:00:00 GMT",
    });
    expect(tutorialSnapshot?.items).toEqual([
      expect.objectContaining({
        canonical_url:
          "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the",
        classification: "tutorial",
        campaign_slug:
          "defitutorials-give-an-agent-the-trigger-never-the",
      }),
    ]);
    const serialized = JSON.stringify(snapshots);
    expect(serialized).not.toContain("Untrusted body");
    expect(serialized).not.toContain("Unstored Author");
    expect(serialized).not.toContain("post-1");
  });

  it("uses persisted validators and records a 304 without any items", async () => {
    const feedHeaders: Headers[] = [];
    const tutorialSnapshots: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://defitutorials.substack.com/feed") {
        feedHeaders.push(new Headers(init?.headers));
        return new Response(null, { status: 304 });
      }
      const body = requestBody(init);
      if (rpcName(input) === "get_marketing_syndication_source_cursor") {
        return json(cursor(body.p_source_key as "openzaps" | "defitutorials", true));
      }
      if (rpcName(input) === "discover_marketing_syndication_items") {
        const snapshot = body.p_snapshot as Record<string, unknown>;
        const items = snapshot.items as unknown[];
        if (snapshot.source_key === "defitutorials") tutorialSnapshots.push(snapshot);
        expect(body.p_initialize_as_baseline).toBe(false);
        return json(discoveryRow(
          snapshot.source_key as "openzaps" | "defitutorials",
          snapshot.not_modified ? "not_modified" : "discovered",
          items.length,
        ));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await discoverMarketingSyndication({
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(feedHeaders[0]?.get("if-none-match")).toBe('"feed-v1"');
    expect(feedHeaders[0]?.get("if-modified-since")).toBe(
      "Sat, 01 Aug 2026 11:00:00 GMT",
    );
    expect(tutorialSnapshots).toEqual([{
      source_key: "defitutorials",
      etag: '"feed-v1"',
      last_modified: "Sat, 01 Aug 2026 11:00:00 GMT",
      not_modified: true,
      items: [],
    }]);
  });

  it("re-reads the cursor before an explicit baseline retry", async () => {
    const cursorCalls = new Map<string, number>();
    const discoveryCalls = new Map<string, number>();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://defitutorials.substack.com/feed") {
        return new Response(FEED);
      }
      const body = requestBody(init);
      const requestedSource = (
        body.p_source_key
        ?? (body.p_snapshot as Record<string, unknown> | undefined)?.source_key
      ) as "openzaps" | "defitutorials";
      if (rpcName(input) === "get_marketing_syndication_source_cursor") {
        const call = (cursorCalls.get(requestedSource) ?? 0) + 1;
        cursorCalls.set(requestedSource, call);
        return json(cursor(requestedSource, call === 1));
      }
      if (rpcName(input) === "discover_marketing_syndication_items") {
        const call = (discoveryCalls.get(requestedSource) ?? 0) + 1;
        discoveryCalls.set(requestedSource, call);
        const count = ((body.p_snapshot as Record<string, unknown>).items as unknown[]).length;
        if (call === 1) {
          expect(body.p_initialize_as_baseline).toBe(false);
          return json(discoveryRow(requestedSource, "baseline_required", count));
        }
        expect(body.p_initialize_as_baseline).toBe(true);
        return json(discoveryRow(requestedSource, "baselined", count));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await discoverMarketingSyndication({
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.sources.map((entry) => entry.result)).toEqual([
      "initialized",
      "initialized",
    ]);
    expect(cursorCalls).toEqual(new Map([
      ["openzaps", 2],
      ["defitutorials", 2],
    ]));
  });

  it("refuses an empty or incomplete first tutorial baseline", async () => {
    for (const feed of [
      "<rss><channel></channel></rss>",
      `<rss><channel><item><title>Unrelated</title><link>https://defitutorials.substack.com/p/unrelated</link><pubDate>Sat, 01 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
      `<rss><channel><item><title>Wrong approved title</title><link>https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the</link><pubDate>Sat, 01 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
    ]) {
      const fetchMock = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://defitutorials.substack.com/feed") {
          return new Response(feed);
        }
        const body = requestBody(init);
        if (rpcName(input) === "get_marketing_syndication_source_cursor") {
          return json(cursor(
            body.p_source_key as "openzaps" | "defitutorials",
            false,
          ));
        }
        if (rpcName(input) === "discover_marketing_syndication_items") {
          const snapshot = body.p_snapshot as Record<string, unknown>;
          if (snapshot.source_key === "defitutorials") {
            throw new Error("Tutorial baseline must not be persisted.");
          }
          return json(discoveryRow("openzaps", "baselined", 4));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await expect(discoverMarketingSyndication({
        env: ENV,
        fetchImpl: fetchMock as typeof fetch,
      })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("refuses an empty successful tutorial snapshot after initialization", async () => {
    let tutorialPersistenceCalls = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://defitutorials.substack.com/feed") {
        return new Response("<rss><channel></channel></rss>", {
          headers: { etag: '"empty-feed"' },
        });
      }
      const body = requestBody(init);
      if (rpcName(input) === "get_marketing_syndication_source_cursor") {
        return json(cursor(
          body.p_source_key as "openzaps" | "defitutorials",
          true,
        ));
      }
      if (rpcName(input) === "discover_marketing_syndication_items") {
        const snapshot = body.p_snapshot as Record<string, unknown>;
        if (snapshot.source_key === "defitutorials") {
          tutorialPersistenceCalls += 1;
          throw new Error("Empty successful feed must not advance its cursor.");
        }
        return json(discoveryRow("openzaps", "discovered", 4));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(discoverMarketingSyndication({
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toMatchObject({ code: "invalid_response" });
    expect(tutorialPersistenceCalls).toBe(0);
  });

  it.each([
    ["first-baseline", false],
    ["later", true],
  ] as const)(
    "rejects a credential-like tutorial title before %s discovery persistence",
    async (_label, initialized) => {
      let tutorialPersistenceCalls = 0;
      const fetchMock = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://defitutorials.substack.com/feed") {
          return new Response(POISONED_TITLE_FEED);
        }
        const body = requestBody(init);
        if (rpcName(input) === "get_marketing_syndication_source_cursor") {
          return json(cursor(
            body.p_source_key as "openzaps" | "defitutorials",
            initialized,
          ));
        }
        if (rpcName(input) === "discover_marketing_syndication_items") {
          const snapshot = body.p_snapshot as Record<string, unknown>;
          if (snapshot.source_key === "defitutorials") {
            tutorialPersistenceCalls += 1;
            throw new Error("Poisoned title must not be persisted.");
          }
          return json(discoveryRow(
            "openzaps",
            initialized ? "discovered" : "baselined",
            4,
          ));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await expect(discoverMarketingSyndication({
        env: ENV,
        fetchImpl: fetchMock as typeof fetch,
      })).rejects.toThrow(/credential-like data/u);
      expect(tutorialPersistenceCalls).toBe(0);
    },
  );

  it("rejects poisoned feed validators before persistence", async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://defitutorials.substack.com/feed") {
        return new Response(FEED, {
          headers: { etag: `Authorization: Bearer ${"a".repeat(32)}` },
        });
      }
      const body = requestBody(init);
      if (rpcName(input) === "get_marketing_syndication_source_cursor") {
        return json(cursor(
          body.p_source_key as "openzaps" | "defitutorials",
          false,
        ));
      }
      if (rpcName(input) === "discover_marketing_syndication_items") {
        const snapshot = body.p_snapshot as Record<string, unknown>;
        if (snapshot.source_key === "defitutorials") {
          throw new Error("Poisoned validator must not be persisted.");
        }
        return json(discoveryRow("openzaps", "baselined", 4));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(discoverMarketingSyndication({
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toMatchObject({
      code: "invalid_response",
      message: "The tutorial feed returned invalid cache validators.",
    });
  });

  it("lists only validated camel-case operator fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([listRow()]));

    await expect(listMarketingSyndicationItems(20, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toEqual([{
      itemId: ITEM_ID,
      source: "openzaps",
      title: "Practice deployed routes in Virtual Trading",
      canonicalUrl: "https://www.0xzaps.com/virtual-trading",
      publishedAt: "2026-07-30T12:01:00.000Z",
      classification: "reviewable",
      status: "pending",
      campaignSlug: "openzaps-openzaps-virtual-trading-2026-07-30",
      workflowRunId: null,
      discoveredAt: NOW,
      updatedAt: NOW,
    }]);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      `${REST}rpc/list_marketing_syndication_items`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ p_limit: 20 }) }),
    );
  });

  it("rejects malformed durable rows rather than presenting partial data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([
      listRow({ canonical_url: "https://attacker.example/post" }),
    ]));

    await expect(listMarketingSyndicationItems(20, {
      env: ENV,
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("claims exactly one item and maps completed replays without a second claim", async () => {
    const claimRow = {
      result_code: "already_completed",
      ...listRow({
        state: "awaiting_approval",
        workflow_run_id: "wrun_existing",
      }),
    };
    const fetchMock = vi.fn().mockResolvedValue(json([claimRow]));

    await expect(claimMarketingSyndicationDraft(ITEM_ID, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({
      result: "already_drafted",
      item: { itemId: ITEM_ID, workflowRunId: "wrun_existing" },
    });
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toEqual({ p_item_id: ITEM_ID });
  });

  it("maps an attached drafting replay to its existing workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([{
      result_code: "already_claimed",
      ...listRow({
        state: "drafting",
        workflow_run_id: "wrun_existing",
      }),
    }]));

    await expect(claimMarketingSyndicationDraft(ITEM_ID, {
      env: ENV,
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({
      result: "already_drafted",
      item: { status: "drafting", workflowRunId: "wrun_existing" },
    });
  });

  it("rejects a valid but swapped claim item id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([{
      result_code: "already_claimed",
      ...listRow({
        item_id: "b".repeat(64),
        state: "drafting",
        workflow_run_id: "wrun_existing",
      }),
    }]));

    await expect(claimMarketingSyndicationDraft(ITEM_ID, {
      env: ENV,
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses strict attachment, failure, skip, and workflow-sync RPC bodies", async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      void _init;
      const name = rpcName(input);
      const result = name === "attach_marketing_syndication_workflow"
        ? "attached"
        : name === "fail_marketing_syndication_draft"
          ? "failed"
          : name === "skip_marketing_syndication_item"
            ? "skipped"
            : "synced";
      const state = result === "attached"
        ? "drafting"
        : result === "failed"
          ? "failed"
          : result === "skipped"
            ? "skipped"
            : "published";
      return json([{
        result_code: result,
        item_id: ITEM_ID,
        state,
        workflow_run_id:
          result === "skipped" || result === "failed" ? null : "wrun_1",
        state_changed_at: NOW,
      }]);
    });

    await attachMarketingSyndicationWorkflow(ITEM_ID, "wrun_1", {
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });
    await failMarketingSyndicationDraft(ITEM_ID, {
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });
    await skipMarketingSyndicationItem(ITEM_ID, {
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });
    await syncMarketingSyndicationStatus(ITEM_ID, "wrun_1", "published", {
      env: ENV,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock.mock.calls.map(([, init]) => requestBody(init))).toEqual([
      { p_item_id: ITEM_ID, p_workflow_run_id: "wrun_1" },
      { p_item_id: ITEM_ID },
      { p_item_id: ITEM_ID },
      { p_item_id: ITEM_ID, p_workflow_run_id: "wrun_1", p_state: "published" },
    ]);
  });

  it("rejects invalid identifiers without calling the service-role API", async () => {
    const fetchMock = vi.fn();

    await expect(claimMarketingSyndicationDraft("bad", {
      env: ENV,
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(syncMarketingSyndicationStatus(
      ITEM_ID,
      "bad/run",
      "published",
      { env: ENV, fetchImpl: fetchMock },
    )).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes service-role API failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("service-secret echoed by provider", { status: 503 }),
    );

    await expect(listMarketingSyndicationItems(20, {
      env: ENV,
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({
      code: "rpc_error",
      message: "The durable marketing syndication inbox rejected the request (503).",
    });
  });
});
