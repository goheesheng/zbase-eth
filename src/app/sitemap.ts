import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: "https://zbase.app",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: "https://zbase.app/app",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.6,
    },
  ];
}
