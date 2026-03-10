'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Operations',
    title: 'Do not stop at review output.',
    subtitle: 'Make the runtime observable.',
    body:
      'The real question after rollout is whether you can quickly tell if webhook delivery, provider configuration, or platform setup is failing.',
    stats: [
      { value: '/health', label: 'Liveness + Deep Probe' },
      { value: '/metrics', label: 'Prometheus Metrics' },
      { value: 'replay', label: 'Stored Event Replay' },
    ],
    cta: 'Read FAQ',
  },
  zh: {
    label: '运维与监控',
    title: '不要只停留在评审输出。',
    subtitle: '还要让运行时可观测。',
    body:
      '真正上线之后，更关键的是能不能快速判断 webhook 传递、模型配置或平台接入到底哪里出了问题。',
    stats: [
      { value: '/health', label: '存活与深度检查' },
      { value: '/metrics', label: 'Prometheus 指标' },
      { value: 'replay', label: '事件回放' },
    ],
    cta: '阅读 FAQ',
  },
} as const

export default function TrustSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="operations" className="relative bg-black py-24 lg:py-32 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-[#0055fe]/8 rounded-full blur-[100px]" />
      </div>

      <div className="relative max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="border border-white/8 bg-[#080808] p-12 lg:p-16 text-center flex flex-col items-center gap-8">
          <div className="inline-flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">{copy.label}</span>
          </div>

          <div>
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight">
              {copy.title}
            </h2>
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight">
              {copy.subtitle}
            </h2>
          </div>

          <p className="text-white/50 text-base leading-relaxed max-w-[520px]">{copy.body}</p>

          <div className="flex flex-wrap justify-center gap-8 lg:gap-16 pt-4 border-t border-white/8 w-full">
            {copy.stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl font-bold text-white mb-1">{stat.value}</div>
                <div className="text-white/45 text-sm">{stat.label}</div>
              </div>
            ))}
          </div>

          <Link
            href="#faq"
            className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors"
          >
            {copy.cta}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  )
}
