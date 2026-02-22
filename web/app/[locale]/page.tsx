import type { Metadata } from "next";

import { StudioHome } from "@/components/home/studio-home";
import {
  SEO_KEYWORDS,
  SITE_NAME,
  getLocaleAlternates,
  getLocalePath,
  getLocaleSeoConfig,
  type SupportedLocale,
} from "@/lib/seo-geo";

interface LocalePageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LocalePageProps): Promise<Metadata> {
  const { locale } = await params;
  // Layout already validates locale via hasLocale + notFound()
  const resolvedLocale = locale as SupportedLocale;
  const seo = getLocaleSeoConfig(resolvedLocale);
  const alternates = getLocaleAlternates();

  return {
    title: seo.title,
    description: seo.description,
    keywords: SEO_KEYWORDS,
    alternates: {
      canonical: getLocalePath(resolvedLocale),
      languages: alternates.languages,
    },
    openGraph: {
      type: "website",
      url: alternates.canonical[resolvedLocale],
      siteName: SITE_NAME,
      title: seo.title,
      description: seo.description,
      locale: seo.openGraphLocale,
      alternateLocale: [resolvedLocale === "en" ? "zh_CN" : "en_US"],
      images: [
        {
          url: "/icon.svg",
          type: "image/svg+xml",
          alt: "PR Agent icon",
        },
      ],
    },
    twitter: {
      card: "summary",
      title: seo.title,
      description: seo.description,
      images: ["/icon.svg"],
    },
  };
}

export default async function LocalePage({ params }: LocalePageProps) {
  const { locale } = await params;
  const resolvedLocale = locale as SupportedLocale;

  return <StudioHome locale={resolvedLocale} />;
}
