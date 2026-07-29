import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEFITUTORIALS_EDITOR_URL,
  DEFITUTORIALS_FEED_URL,
  createSubstackEditorHandoff,
  fetchSubstackFeed,
  parseSubstackRss,
} from "./substack";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>DeFi Tutorials</title>
    <item>
      <title><![CDATA[Zaps &amp; bounded agents]]></title>
      <link>https://defitutorials.substack.com/p/bounded-zaps</link>
      <guid isPermaLink="false">post-42</guid>
      <pubDate>Tue, 28 Jul 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>One transaction, with explicit limits.</p>]]></description>
      <dc:creator><![CDATA[Nodar]]></dc:creator>
    </item>
    <item>
      <title>External link should not syndicate</title>
      <link>https://attacker.example/post</link>
      <guid>bad-post</guid>
    </item>
  </channel>
</rss>`;

describe("Substack editor handoff", () => {
  it("creates a human-publish package without calling a private API", () => {
    expect(
      createSubstackEditorHandoff({
        title: "  How bounded Zaps work  ",
        subtitle: "  An execution walkthrough  ",
        bodyMarkdown: "# Tutorial\n\nDo the thing.",
        tags: [" DeFi ", "OpenZaps"],
        idempotencyKey: "tutorial:bounded-zaps",
      }),
    ).toEqual({
      channel: "substack",
      status: "requires-human-publish",
      editorUrl: DEFITUTORIALS_EDITOR_URL,
      publicationUrl: "https://defitutorials.substack.com",
      idempotencyKey: "tutorial:bounded-zaps",
      apiWriteAttempted: false,
      privateEndpointUsed: false,
      draft: {
        title: "How bounded Zaps work",
        subtitle: "An execution walkthrough",
        bodyMarkdown: "# Tutorial\n\nDo the thing.",
        tags: ["DeFi", "OpenZaps"],
      },
    });
  });

  it("allows a tutorial without an optional subtitle", () => {
    expect(
      createSubstackEditorHandoff({
        title: "A direct walkthrough",
        bodyMarkdown: "Start here.",
        idempotencyKey: "tutorial:no-subtitle",
      }).draft,
    ).toEqual({
      title: "A direct walkthrough",
      bodyMarkdown: "Start here.",
      tags: [],
    });
  });

  it("rejects an empty body and invalid idempotency key", () => {
    expect(() =>
      createSubstackEditorHandoff({
        title: "No body",
        bodyMarkdown: "   ",
        idempotencyKey: "contains spaces",
      }),
    ).toThrow("idempotencyKey");
  });
});

describe("Substack RSS ingestion", () => {
  it("parses and bounds public DeFi Tutorials RSS items", () => {
    expect(parseSubstackRss(FEED)).toEqual([
      {
        id: "post-42",
        title: "Zaps & bounded agents",
        url: "https://defitutorials.substack.com/p/bounded-zaps",
        publishedAt: "2026-07-28T12:00:00.000Z",
        description: "One transaction, with explicit limits.",
        author: "Nodar",
      },
    ]);
  });

  it("fetches only the public feed and returns cache validators", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(FEED, {
        status: 200,
        headers: {
          etag: '"feed-v2"',
          "last-modified": "Tue, 28 Jul 2026 12:00:00 GMT",
        },
      }),
    );

    await expect(
      fetchSubstackFeed(
        {
          idempotencyKey: "feed:2026-07-28T12",
          etag: '"feed-v1"',
          lastModified: "Tue, 28 Jul 2026 11:00:00 GMT",
        },
        { fetchImpl: fetchMock },
      ),
    ).resolves.toMatchObject({
      channel: "substack",
      feedUrl: DEFITUTORIALS_FEED_URL,
      idempotencyKey: "feed:2026-07-28T12",
      notModified: false,
      etag: '"feed-v2"',
      posts: [{ id: "post-42" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://defitutorials.substack.com/feed");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      "if-none-match": '"feed-v1"',
      "if-modified-since": "Tue, 28 Jul 2026 11:00:00 GMT",
    });
    expect(init.headers).not.toHaveProperty("cookie");
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("handles a 304 without parsing a body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 304 }));

    await expect(
      fetchSubstackFeed(
        { idempotencyKey: "feed:not-modified" },
        { fetchImpl: fetchMock },
      ),
    ).resolves.toEqual({
      channel: "substack",
      feedUrl: DEFITUTORIALS_FEED_URL,
      idempotencyKey: "feed:not-modified",
      notModified: true,
      posts: [],
    });
  });

  it("rejects malformed feed responses and never falls back to private endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>login</html>", { status: 200 }));

    await expect(
      fetchSubstackFeed(
        { idempotencyKey: "feed:malformed" },
        { fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({
      channel: "substack",
      code: "invalid-response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
