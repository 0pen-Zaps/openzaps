import type { MetadataRoute } from "next";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://openzaps.vercel.app");

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: siteUrl, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/app`, lastModified, changeFrequency: "weekly", priority: 0.95 },
    { url: `${siteUrl}/docs`, lastModified, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/security`, lastModified, changeFrequency: "weekly", priority: 0.88 },
    { url: `${siteUrl}/pricing`, lastModified, changeFrequency: "weekly", priority: 0.75 },
    { url: `${siteUrl}/roadmap`, lastModified, changeFrequency: "weekly", priority: 0.72 },
    { url: `${siteUrl}/token`, lastModified, changeFrequency: "weekly", priority: 0.7 },
    { url: `${siteUrl}/legal`, lastModified, changeFrequency: "monthly", priority: 0.55 },
  ];
}
