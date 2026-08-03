import type { MetadataRoute } from "next";
import { STATIC_PAGE_SEO, absoluteUrl } from "@/lib/seo";
import { fetchZapAddresses } from "@/lib/zap-server";

const MAX_DYNAMIC_URLS = 49_000;

export const revalidate = 300;

// One timestamp per deployment. Google schedules recrawls primarily off
// <lastmod> and has said it ignores <changefreq>/<priority>, so without this the
// sitemap invested only in the signals it discards. Static routes change when
// the site is rebuilt, and the dynamic zap listing is republished each deploy;
// evaluated once at module load, so it is the deploy time, not per-request now.
const BUILD_TIME = new Date();

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = Object.values(STATIC_PAGE_SEO).map(
    ({ path, priority, changeFrequency, ogImage }) => ({
      url: absoluteUrl(path),
      lastModified: BUILD_TIME,
      changeFrequency,
      priority,
      images: [absoluteUrl(ogImage)],
    }),
  );

  try {
    const addresses = await fetchZapAddresses(MAX_DYNAMIC_URLS);
    const zapEntries: MetadataRoute.Sitemap = addresses.map((address) => ({
      url: absoluteUrl(`/explore/${address}`),
      lastModified: BUILD_TIME,
      changeFrequency: "daily",
      priority: 0.7,
      images: [absoluteUrl("/og.png")],
    }));
    return [...staticEntries, ...zapEntries];
  } catch {
    // Search discovery must remain available when the RPC is temporarily degraded.
    console.warn("[sitemap] Onchain zap enumeration unavailable; serving static routes only.");
    return staticEntries;
  }
}
