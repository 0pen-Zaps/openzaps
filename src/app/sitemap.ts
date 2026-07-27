import type { MetadataRoute } from "next";
import { STATIC_PAGE_SEO, absoluteUrl } from "@/lib/seo";
import { fetchZapAddresses } from "@/lib/zap-server";

const MAX_DYNAMIC_URLS = 49_000;

export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = Object.values(STATIC_PAGE_SEO).map(
    ({ path, priority, changeFrequency, ogImage }) => ({
      url: absoluteUrl(path),
      changeFrequency,
      priority,
      images: [absoluteUrl(ogImage)],
    }),
  );

  try {
    const addresses = await fetchZapAddresses(MAX_DYNAMIC_URLS);
    const zapEntries: MetadataRoute.Sitemap = addresses.map((address) => ({
      url: absoluteUrl(`/explore/${address}`),
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
