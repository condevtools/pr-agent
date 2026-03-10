'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Deployment Modes',
    title: 'Choose the integration path first.',
    subtitle: 'Then complete the rollout baseline.',
    body:
      'The repository README already gives a practical rollout order: choose platform mode, configure model provider, enable durable runtime state, verify health, then test inside a real PR or MR.',
    cards: [
      {
        type: 'Recommended',
        title: 'GitHub App',
        description:
          'Best overall coverage with a cleaner permission model, making it the preferred path for long-running production use.',
        price: '01',
        period: '/ mode',
        duration: 'Best coverage',
        includes: ['Most complete feature path', 'Fits long-running production use'],
        cta: null,
      },
      {
        type: 'Compatible',
        title: 'GitHub Webhook',
        description:
          'A good fit when you want direct webhook integration and a faster first validation for automatic review and commands.',
        price: '02',
        period: '/ mode',
        duration: 'Fast validation',
        includes: ['Lower setup cost', 'Good for trial rollout'],
        cta: null,
      },
      {
        type: 'Optional',
        title: 'GitLab Webhook',
        description:
          'Keeps GitLab support in play and allows review-mode override through headers for platform-specific rollout control.',
        price: '03',
        period: '/ mode',
        duration: 'As needed',
        includes: ['Supports x-ai-mode override', 'Useful for mixed platform teams'],
        cta: 'View Operations',
      },
    ],
  },
  zh: {
    label: '接入方式',
    title: '先选接入模式。',
    subtitle: '再补齐部署基线。',
    body:
      '仓库 README 已经给出比较实用的上线顺序：先选平台模式，再配置模型提供商、持久化运行时状态，验证健康检查，最后在真实 PR/MR 中测试。',
    cards: [
      {
        type: '推荐',
        title: 'GitHub App',
        description:
          '功能覆盖最完整，权限模型也更清晰，是更适合长期生产运行的接入方式。',
        price: '01',
        period: '/ 模式',
        duration: '功能最全',
        includes: ['能力路径最完整', '适合长期生产运行'],
        cta: null,
      },
      {
        type: '兼容',
        title: 'GitHub Webhook',
        description:
          '适合希望直接接入现有 webhook 的团队，也便于先快速验证自动评审与命令能力。',
        price: '02',
        period: '/ 模式',
        duration: '快速验证',
        includes: ['配置成本较低', '适合试运行'],
        cta: null,
      },
      {
        type: '可选',
        title: 'GitLab Webhook',
        description:
          '保留 GitLab 接入能力，并支持通过请求头覆盖评审模式，方便按平台做差异化落地。',
        price: '03',
        period: '/ 模式',
        duration: '按需开启',
        includes: ['支持 x-ai-mode 覆盖', '适合混合平台团队'],
        cta: '查看运维',
      },
    ],
  },
} as const

export default function ServicesSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="deployment" className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">{copy.label}</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">{copy.title}</h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">{copy.subtitle}</h2>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[420px]">{copy.body}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/8">
          {copy.cards.map((service) => (
            <div
              key={service.title}
              className="bg-black border border-white/8 p-8 lg:p-10 flex flex-col gap-6"
            >
              <span className="inline-flex w-fit px-2.5 py-1 border border-white/12 text-white/45 text-xs">
                {service.type}
              </span>

              <h3 className="text-white text-xl font-semibold">{service.title}</h3>

              <p className="text-white/50 text-sm leading-relaxed flex-1">{service.description}</p>

              <div className="flex items-end gap-2 pt-2 border-t border-white/8">
                <span className="text-white text-3xl font-bold">{service.price}</span>
                <span className="text-white/40 text-sm mb-1">{service.period}</span>
                <div className="ml-auto text-right">
                  <span className="text-[#0055fe] text-sm font-medium">{service.duration}</span>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                {service.includes.map((item) => (
                  <div key={item} className="flex items-center gap-2.5">
                    <svg
                      className="w-3.5 h-3.5 text-[#0055fe] flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-white/65 text-sm">{item}</span>
                  </div>
                ))}
              </div>

              {service.cta ? (
                <Link
                  href="#operations"
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
                >
                  {service.cta}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
