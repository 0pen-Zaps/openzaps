export interface OpenZapsFeedItem {
  id: string;
  title: string;
  description: string;
  url: string;
  publishedAt: string;
}

const SITE_URL = "https://www.0xzaps.com";

/**
 * Only already-public, maintainer-approved product material belongs here.
 * Draft tutorials are intentionally absent until their canonical publication
 * exists; Substack's own RSS feed triggers their later syndication.
 */
export const OPENZAPS_FEED_ITEMS: readonly OpenZapsFeedItem[] = [
  {
    id: "openzaps-bounded-agent-authority-2026-07-27",
    title: "Give an agent the trigger, never the authority",
    description:
      "How OpenZaps separates owner creation authority, immutable execution authority, and the executor that submits a due run.",
    url: `${SITE_URL}/docs`,
    // Canonical repository commit e69ccd6, which shipped the current policy documentation.
    publishedAt: "2026-07-29T00:21:56.000Z",
  },
  {
    id: "openzaps-live-chain-explorer-2026-07-28",
    title: "Verify OpenZaps activity from chain evidence",
    description:
      "The OpenZaps explorer exposes factory-derived Zaps, executions, automated runs, recoveries, and the block used for each live read.",
    url: `${SITE_URL}/explore`,
    // Canonical repository commit ce73fe0, which shipped the current explorer surface.
    publishedAt: "2026-07-28T03:42:55.000Z",
  },
] as const;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entity: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entity[character];
  });
}

export function renderOpenZapsRss(
  items: readonly OpenZapsFeedItem[] = OPENZAPS_FEED_ITEMS,
): string {
  const sorted = [...items].sort(
    (left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );
  const lastBuildDate = sorted[0]?.publishedAt ?? "2026-07-29T00:21:56.000Z";
  const entries = sorted
    .map(
      (item) => `    <item>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <description>${escapeXml(item.description)}</description>
      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenZaps updates</title>
    <link>${SITE_URL}</link>
    <description>Evidence-backed OpenZaps product, protocol, and tutorial updates.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date(lastBuildDate).toUTCString()}</lastBuildDate>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
${entries}
  </channel>
</rss>
`;
}
