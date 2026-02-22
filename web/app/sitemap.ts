import type { MetadataRoute } from "next";
import { SITE_URL, getLocalePath } from "@/lib/seo-geo";

export default function sitemap(): MetadataRoute.Sitemap {
  const updatedAt = new Date();

  return [
    {
      url: new URL(getLocalePath("en"), SITE_URL).toString(),
      lastModified: updatedAt,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: new URL(getLocalePath("zh"), SITE_URL).toString(),
      lastModified: updatedAt,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];
}
