'use client'

import HashLink from './HashLink'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Get Started',
    title: 'Run PR Agent on a real pull request.',
    subtitle: 'Then decide how far to roll it out.',
    body:
      'If you only do one thing, wire a webhook, verify /health, and run /ai-review inside a comment thread. That reveals more than another static mockup ever will.',
    cta: 'View Deployment Modes',
    brand: 'PR Agent',
    copyright: '© 2026 PR Agent. All rights reserved.',
    footerLinks: [
      { label: 'Capability Map', href: '#features' },
      { label: 'Deployment FAQ', href: '#faq' },
    ],
  },
  zh: {
    label: '开始接入',
    title: '先让 PR Agent 在真实 PR 里跑起来。',
    subtitle: '再决定要接入到什么程度。',
    body:
      '如果只做一件事，那就先接好 webhook，验证 /health，然后在评论区运行一次 /ai-review。它比继续堆静态营销页面更接近真实落地。',
    cta: '查看接入方式',
    brand: 'PR Agent',
    copyright: '© 2026 PR Agent. All rights reserved.',
    footerLinks: [
      { label: '能力概览', href: '#features' },
      { label: '部署 FAQ', href: '#faq' },
    ],
  },
} as const

export default function CTASection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <>
      <section id="cta" className="relative bg-black py-20 md:py-24 lg:py-32 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-[#0055fe]/12 rounded-full blur-[100px]" />
        </div>

        <div className="relative max-w-[1440px] mx-auto px-5 sm:px-6 lg:px-10 text-center">
          <div data-gsap="reveal" className="inline-flex items-center gap-2 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">{copy.label}</span>
          </div>

          <h2 data-gsap="reveal" className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-3">
            {copy.title}
          </h2>
          <h2 data-gsap="reveal" className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-8">
            {copy.subtitle}
          </h2>

          <p data-gsap="reveal" className="text-white/50 text-base leading-relaxed max-w-[520px] mx-auto mb-10">{copy.body}</p>

          <HashLink
            href="#deployment"
            data-gsap="reveal"
            className="inline-flex w-full sm:w-auto justify-center items-center gap-3 px-10 py-4 bg-[#0055fe] text-white font-medium hover:bg-[#0044cc] transition-colors"
          >
            {copy.cta}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </HashLink>
        </div>
      </section>

      <footer className="bg-black border-t border-white/8 py-10">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold text-white">{copy.brand}</span>
            <span className="text-white/20 hidden sm:block">|</span>
            <span className="text-white/40 text-sm">{copy.copyright}</span>
          </div>
          <div className="flex items-center gap-6">
            {copy.footerLinks.map((link) => (
              <HashLink
                key={link.label}
                href={link.href}
                className="text-white/40 text-sm hover:text-white/70 transition-colors"
              >
                {link.label}
              </HashLink>
            ))}
          </div>
        </div>
      </footer>
    </>
  )
}
