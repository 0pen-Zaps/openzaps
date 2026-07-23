import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

const ROUTES = [
  { path: "", priority: 1, changeFrequency: "weekly" },
  { path: "/zap", priority: 0.95, changeFrequency: "weekly" },
    // Only the index: per-zap URLs are minted onchain, so enumerating them here
  // would need an RPC read at build time and would go stale the moment the
  // next capsule is deployed. The index links every one of them.
  { path: "/explore", priority: 0.92, changeFrequency: "daily" },
  { path: "/docs", priority: 0.9, changeFrequency: "weekly" },
  { path: "/roadmap", priority: 0.72, changeFrequency: "weekly" },
  { path: "/token", priority: 0.7, changeFrequency: "weekly" },
  { path: "/legal", priority: 0.55, changeFrequency: "monthly" },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
