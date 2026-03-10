import type { MetadataRoute } from 'next'
import { SITE_URL } from '../lib/seo-geo'

export default function sitemap(): MetadataRoute.Sitemap {
  const updatedAt = new Date()

  return [
    {
      url: SITE_URL,
      lastModified: updatedAt,
      changeFrequency: 'weekly',
      priority: 1,
    },
  ]
}
