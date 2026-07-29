import { renderOpenZapsRss } from "@/lib/marketing/feed";

export const revalidate = 3_600;

export function GET(): Response {
  return new Response(renderOpenZapsRss(), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
