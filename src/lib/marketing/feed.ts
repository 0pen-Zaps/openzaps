import tutorialManifestJson from "../../../docs/tutorials/manifest.json";

import { normalizeConfirmedTutorialManifest } from "@/lib/marketing/tutorial-publication";

export interface OpenZapsFeedItem {
  id: string;
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

const SITE_URL = "https://www.0xzaps.com";

/**
 * Only already-public, maintainer-approved product material belongs here.
 * Draft tutorials are intentionally absent until their canonical publication
 * exists; Substack's own RSS feed can source their later reviewed syndication.
 */
export const OPENZAPS_FEED_ITEMS: readonly OpenZapsFeedItem[] = [
  {
    id: "openzaps-fee-rewards-2026-08-02",
    title: "Inspect the first fixed 0xZAPS fee campaign",
    description:
      "Inspect the separately funded 2026 campaign, active from Aug 3 00:23 UTC until Aug 10 00:23 UTC; claims remain available until Sep 9 00:23 UTC. It uses 50 of 100 tokenized Clanker fee shares, 0xZAPS stake principal, and WETH-only campaign rewards allocated by time-weighted stake. Holding 0xZAPS alone grants no fee rights.",
    url: `${SITE_URL}/rewards`,
    // Canonical repository commit 5490328, which shipped the live rewards surface.
    publishedAt: "2026-08-02T06:13:46.000Z",
  },
  {
    id: "openzaps-virtual-trading-2026-07-30",
    title: "Practice deployed routes in Virtual Trading",
    description:
      "Paper-trade the deployed 0xZAPS/USDG and aeWETH/USDG routes with 10,000 virtual USDG and live read-only quotes, without a wallet or real funds.",
    url: `${SITE_URL}/virtual-trading`,
    // Canonical repository commit 02470cf, which shipped Virtual Trading.
    publishedAt: "2026-07-30T12:01:00.000Z",
  },
  {
    id: "openzaps-request-a-zap-2026-07-30",
    title: "Request a bounded Zap workflow",
    description:
      "Submit one DeFi workflow to request a human-reviewed authority map covering what an agent may trigger and what it can never change.",
    url: `${SITE_URL}/request-a-zap`,
    ctaLabel: "Request a Zap",
    ctaUrl:
      `${SITE_URL}/request-a-zap?utm_source=openzaps&utm_medium=rss&utm_campaign=request_a_zap&utm_content=feed_update`,
    // Canonical repository commit bc4db0a, which shipped the lead engine.
    publishedAt: "2026-07-30T09:15:30.000Z",
  },
  {
    id: "openzaps-agent-kit-2026-07-29",
    title: "Connect an agent with the OpenZaps Agent Kit",
    description:
      "The published SDK compiles exact policy and unsigned EIP-712 artifacts; the read-only MCP server discovers capsules and can request deployment-gated, block-pinned simulation. Neither package signs or broadcasts.",
    url: `${SITE_URL}/agent-kit`,
    ctaLabel: "Explore the Agent Kit",
    ctaUrl:
      `${SITE_URL}/agent-kit?utm_source=openzaps&utm_medium=rss&utm_campaign=agent_kit&utm_content=feed_update`,
    // npm registry publication time for @openzaps/mcp@0.1.0.
    publishedAt: "2026-07-29T23:42:16.227Z",
  },
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

const CONFIRMED_TUTORIAL_FEED_ITEMS: readonly OpenZapsFeedItem[] =
  normalizeConfirmedTutorialManifest(tutorialManifestJson).map((tutorial) => ({
    id: `defitutorials-${tutorial.id}`,
    title: tutorial.title,
    description:
      "Read the source-reviewed walkthrough on DeFi Tutorials. Verify every bound before using real funds.",
    url: tutorial.canonicalUrl,
    publishedAt: tutorial.publishedAt,
  }));

export const OPENZAPS_RSS_ITEMS: readonly OpenZapsFeedItem[] = Object.freeze([
  ...OPENZAPS_FEED_ITEMS,
  ...CONFIRMED_TUTORIAL_FEED_ITEMS,
]);

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
  items: readonly OpenZapsFeedItem[] = OPENZAPS_RSS_ITEMS,
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
      <description>${escapeXml(
        item.ctaLabel && item.ctaUrl
          ? `${item.description}\n\n${item.ctaLabel}: ${item.ctaUrl}`
          : item.description,
      )}</description>
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
