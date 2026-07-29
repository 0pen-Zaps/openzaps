import { describe, expect, it } from "vitest";

import { renderOpenZapsRss } from "@/lib/marketing/feed";

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
});
