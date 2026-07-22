import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

const ROUTES = [
  { path: "", priority: 1, changeFrequency: "weekly" },
  { path: "/app", priority: 0.95, changeFrequency: "weekly" },
  { path: "/build", priority: 0.92, changeFrequency: "weekly" },
  { path: "/dashboard", priority: 0.9, changeFrequency: "daily" },
  { path: "/docs", priority: 0.9, changeFrequency: "weekly" },
  { path: "/security", priority: 0.88, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.75, changeFrequency: "weekly" },
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
