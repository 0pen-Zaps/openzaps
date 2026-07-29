import type { MetadataRoute } from "next";
import { STATIC_PAGE_SEO, absoluteUrl } from "@/lib/seo";
import { fetchZapPadTokenAddresses } from "@/lib/zappad-sitemap";
import { fetchZapAddresses } from "@/lib/zap-server";

const MAX_SITEMAP_URLS = 50_000;

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
  const dynamicLimitPerFamily = Math.floor(
    (MAX_SITEMAP_URLS - staticEntries.length) / 2,
  );

  const [zapResult, launchResult] = await Promise.allSettled([
    fetchZapAddresses(dynamicLimitPerFamily),
    fetchZapPadTokenAddresses(dynamicLimitPerFamily),
  ]);
  const dynamicEntries: MetadataRoute.Sitemap = [];

  if (zapResult.status === "fulfilled") {
    const addresses = zapResult.value;
    const zapEntries: MetadataRoute.Sitemap = addresses.map((address) => ({
      url: absoluteUrl(`/explore/${address}`),
      changeFrequency: "daily",
      priority: 0.7,
      images: [absoluteUrl("/og.png")],
    }));
    dynamicEntries.push(...zapEntries);
  } else {
    console.warn("[sitemap] Onchain zap enumeration unavailable; omitting Zap detail routes.");
  }

  if (launchResult.status === "fulfilled") {
    const launchEntries: MetadataRoute.Sitemap = launchResult.value.map(
      (address) => ({
        url: absoluteUrl(`/launch/token/${address.toLowerCase()}`),
        changeFrequency: "daily",
        priority: 0.7,
        images: [absoluteUrl("/og/app.png")],
      }),
    );
    dynamicEntries.push(...launchEntries);
  } else {
    console.warn("[sitemap] ZapPad launch enumeration unavailable; omitting token detail routes.");
  }

  return [...staticEntries, ...dynamicEntries];
}
