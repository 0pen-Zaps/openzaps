import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://openzaps.vercel.app");

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: siteUrl, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/token`, lastModified, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/app`, lastModified, changeFrequency: "weekly", priority: 0.8 },
  ];
}
