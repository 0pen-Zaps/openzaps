import { describe, expect, it } from "vitest";

import {
  OPENZAPS_FEED_ITEMS,
  renderOpenZapsRss,
} from "@/lib/marketing/feed";

describe("renderOpenZapsRss", () => {
  it("renders stable GUIDs and escapes untrusted item text", () => {
    const xml = renderOpenZapsRss([
      {
        id: "item-1",
        title: "Zaps & agents",
        description: "<bounded>",
        url: "https://www.0xzaps.com/docs?a=1&b=2",
        publishedAt: "2026-07-28T12:00:00.000Z",
      },
    ]);
    expect(xml).toContain("<guid isPermaLink=\"false\">item-1</guid>");
    expect(xml).toContain("Zaps &amp; agents");
    expect(xml).toContain("&lt;bounded&gt;");
    expect(xml).toContain("a=1&amp;b=2");
  });

  it("includes the latest shipped conversion surfaces in the public feed", () => {
    const xml = renderOpenZapsRss();
    const identity = OPENZAPS_FEED_ITEMS.map(
      ({ id, publishedAt, url }) => ({ id, publishedAt, url }),
    );

    expect(identity).toEqual([
      {
        id: "openzaps-fee-rewards-2026-08-02",
        publishedAt: "2026-08-02T06:13:46.000Z",
        url: "https://www.0xzaps.com/rewards",
      },
      {
        id: "openzaps-virtual-trading-2026-07-30",
        publishedAt: "2026-07-30T12:01:00.000Z",
        url: "https://www.0xzaps.com/virtual-trading",
      },
      {
        id: "openzaps-request-a-zap-2026-07-30",
        publishedAt: "2026-07-30T09:15:30.000Z",
        url: "https://www.0xzaps.com/request-a-zap",
      },
      {
        id: "openzaps-agent-kit-2026-07-29",
        publishedAt: "2026-07-29T23:42:16.227Z",
        url: "https://www.0xzaps.com/agent-kit",
      },
      {
        id: "openzaps-bounded-agent-authority-2026-07-27",
        publishedAt: "2026-07-29T00:21:56.000Z",
        url: "https://www.0xzaps.com/docs",
      },
      {
        id: "openzaps-live-chain-explorer-2026-07-28",
        publishedAt: "2026-07-28T03:42:55.000Z",
        url: "https://www.0xzaps.com/explore",
      },
    ]);
    expect(new Set(identity.map((item) => item.id)).size).toBe(identity.length);
    expect(xml).toContain(
      "<link>https://www.0xzaps.com/rewards</link>",
    );
    expect(xml).toContain("Holding 0xZAPS alone grants no fee rights");
    expect(xml).toContain("Holding 0xZAPS alone grants no fee rights");
    expect(xml).toContain(
      "active from Aug 3 00:23 UTC until Aug 10 00:23 UTC",
    );
    expect(xml).toContain("until Sep 9 00:23 UTC");
    expect(xml).toContain("https://www.0xzaps.com/virtual-trading");
    expect(xml).toContain(
      "<link>https://www.0xzaps.com/agent-kit</link>",
    );
    expect(xml).toContain("deployment-gated, block-pinned simulation");
    expect(xml).toContain(
      "<link>https://www.0xzaps.com/request-a-zap</link>",
    );
    expect(xml).toContain(
      "https://www.0xzaps.com/request-a-zap?utm_source=openzaps&amp;utm_medium=rss&amp;utm_campaign=request_a_zap&amp;utm_content=feed_update",
    );
  });

  it("includes only RSS-confirmed tutorials in the unified feed", () => {
    const xml = renderOpenZapsRss();

    expect(xml).toContain("Give an Agent the Trigger, Never the Authority");
    expect(xml).toContain(
      "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the",
    );
    expect(xml).not.toContain("Paper Trade First, Then Draw the Authority Map");
  });
});
