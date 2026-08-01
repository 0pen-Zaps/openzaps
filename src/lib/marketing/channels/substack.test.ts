import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEFITUTORIALS_EDITOR_URL,
  DEFITUTORIALS_FEED_URL,
  createSubstackEditorHandoff,
  fetchSubstackFeed,
  parseSubstackRss,
  verifySubstackPublication,
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
        bodyHtml: "<h2>Tutorial</h2>\n<p>Do the thing.</p>",
        bodyPlainText: "Tutorial\n\nDo the thing.",
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
      bodyHtml: "<p>Start here.</p>",
      bodyPlainText: "Start here.",
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

describe("Substack publication verification", () => {
  it("confirms only an exact canonical URL and approved RSS title", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(FEED));

    await expect(
      verifySubstackPublication(
        {
          canonicalUrl: "https://defitutorials.substack.com/p/bounded-zaps/",
          approvedTitle: "  Zaps & bounded agents  ",
        },
        { fetchImpl: fetchMock, nowMs: Date.parse("2026-07-29T13:00:00Z") },
      ),
    ).resolves.toEqual({
      channel: "substack",
      status: "rss_confirmed",
      canonicalUrl: "https://defitutorials.substack.com/p/bounded-zaps",
      approvedTitle: "Zaps & bounded agents",
      feedUrl: DEFITUTORIALS_FEED_URL,
      checkedAt: "2026-07-29T13:00:00.000Z",
      publishedAt: "2026-07-28T12:00:00.000Z",
      persisted: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a missing URL from a title mismatch without accepting either", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(FEED));

    await expect(
      verifySubstackPublication(
        {
          canonicalUrl: "https://defitutorials.substack.com/p/not-in-feed",
          approvedTitle: "Zaps & bounded agents",
        },
        { fetchImpl: fetchMock, nowMs: 0 },
      ),
    ).resolves.toMatchObject({ status: "not_found", persisted: false });

    await expect(
      verifySubstackPublication(
        {
          canonicalUrl: "https://defitutorials.substack.com/p/bounded-zaps",
          approvedTitle: "A changed title",
        },
        { fetchImpl: fetchMock, nowMs: 0 },
      ),
    ).resolves.toMatchObject({ status: "title_mismatch", persisted: false });
  });

  it("rejects tracking URLs and alternate Substack hosts before fetching", async () => {
    const fetchMock = vi.fn();

    await expect(
      verifySubstackPublication(
        {
          canonicalUrl:
            "https://defitutorials.substack.com/p/bounded-zaps?utm_source=test",
          approvedTitle: "Zaps & bounded agents",
        },
        { fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("deduplicates by canonical URL rather than untrusted RSS GUID", () => {
    const feed = `
      <rss><channel>
        <item>
          <title>First post</title>
          <link>https://defitutorials.substack.com/p/first-post</link>
          <guid>shared-guid</guid>
        </item>
        <item>
          <title>Second post</title>
          <link>https://defitutorials.substack.com/p/second-post</link>
          <guid>shared-guid</guid>
        </item>
        <item>
          <title>Duplicate first post</title>
          <link>https://defitutorials.substack.com/p/first-post</link>
          <guid>different-guid</guid>
        </item>
      </channel></rss>`;

    expect(parseSubstackRss(feed).map((post) => post.url)).toEqual([
      "https://defitutorials.substack.com/p/first-post",
      "https://defitutorials.substack.com/p/second-post",
    ]);
  });

  it("rejects a truncated feed even when it contains one complete item", () => {
    const truncated = FEED.slice(0, FEED.lastIndexOf("</channel>"));

    expect(() => parseSubstackRss(truncated)).toThrow(
      "Substack returned an invalid feed.",
    );
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
