import type { Metadata } from 'next'
import './globals.css'
import CustomCursor from './components/CustomCursor'
import { LocaleProvider } from './i18n/LocaleProvider'
import { SEO_KEYWORDS, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from '../lib/seo-geo'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: SEO_KEYWORDS,
  alternates: {
    canonical: '/',
  },
  authors: [{ name: 'CondevTools' }],
  creator: 'CondevTools',
  publisher: 'CondevTools',
  category: 'developer tools',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/logo.svg',
        width: 512,
        height: 512,
        alt: 'PR Agent',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/logo.svg'],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <LocaleProvider>
          <CustomCursor />
          {children}
        </LocaleProvider>
      </body>
    </html>
  )
}
