'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useLocale, type Locale } from '../i18n/LocaleProvider'

const NAV_LINKS = {
  en: [
    { label: 'Overview', href: '#overview' },
    { label: 'Capabilities', href: '#features' },
    { label: 'Commands', href: '#commands' },
    { label: 'Deployment', href: '#deployment' },
    { label: 'FAQ', href: '#faq' },
  ],
  zh: [
    { label: '总览', href: '#overview' },
    { label: '能力', href: '#features' },
    { label: '命令', href: '#commands' },
    { label: '部署', href: '#deployment' },
    { label: '常见问题', href: '#faq' },
  ],
} as const

const CTA_LABEL = {
  en: 'Get Started',
  zh: '开始接入',
}

function LocaleSwitch({
  locale,
  setLocale,
  className,
}: {
  locale: Locale
  setLocale: (locale: Locale) => void
  className?: string
}) {
  return (
    <div className={className}>
      {(['en', 'zh'] as const).map((nextLocale) => (
        <button
          key={nextLocale}
          type="button"
          onClick={() => setLocale(nextLocale)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            locale === nextLocale
              ? 'bg-[#0055fe] text-white'
              : 'text-white/70 hover:text-white border-l border-white/10 first:border-l-0'
          }`}
        >
          {nextLocale === 'en' ? 'EN' : '中文'}
        </button>
      ))}
    </div>
  )
}

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const { locale, setLocale } = useLocale()
  const links = NAV_LINKS[locale]

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? 'bg-black/90 backdrop-blur-md' : 'bg-transparent'
      }`}
    >
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10 h-16 flex items-center justify-between gap-4">
        <Link href="#overview" className="flex items-center gap-3">
          <Image src="/logo.svg" alt="PR Agent" width={32} height={32} priority />
          <span className="text-sm font-semibold tracking-[0.16em] text-white/90">PR AGENT</span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-sm font-medium text-white/90 hover:text-white transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-3">
          <LocaleSwitch
            locale={locale}
            setLocale={setLocale}
            className="inline-flex items-center border border-white/10 bg-white/5"
          />
          <Link
            href="#cta"
            className="px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
          >
            {CTA_LABEL[locale]}
          </Link>
        </div>

        <button
          className="md:hidden text-white p-2"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden bg-[#080808] border-t border-white/10 px-6 py-4 flex flex-col gap-2">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-white/70 hover:text-white transition-colors py-2 border-b border-white/5"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <div className="flex items-center justify-between pt-3">
            <LocaleSwitch
              locale={locale}
              setLocale={setLocale}
              className="inline-flex items-center border border-white/10 bg-white/5"
            />
            <Link
              href="#cta"
              className="px-5 py-3 bg-[#0055fe] text-white text-sm font-medium text-center"
              onClick={() => setMobileOpen(false)}
            >
              {CTA_LABEL[locale]}
            </Link>
          </div>
        </div>
      )}
    </nav>
  )
}
