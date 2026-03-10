'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Rollout Path',
    title: 'From trial run to production.',
    subtitle: 'A more realistic two-step path.',
    body:
      'Instead of fake pricing, this section reflects the actual rollout maturity the repository suggests: validate quickly first, then harden for production.',
    plans: [
      {
        badge: 'Quick Start',
        name: 'Trial Run',
        price: '30 min',
        period: '/ first pass',
        description:
          'Best for validating one repository and one real pull request before expanding usage.',
        stats: [
          { value: '1', label: 'test repo' },
          { value: '1', label: 'real PR' },
        ],
        features: [
          'Configure AI provider and model',
          'Set webhook URL and secret',
          'Run /ai-review in a comment thread',
          'Verify /health and platform health endpoints',
        ],
        cta: 'Start First Validation',
        highlight: false,
      },
      {
        badge: 'Production',
        name: 'Baseline',
        price: 'Prod-ready',
        period: '/ rollout',
        description:
          'Best for teams that want durable runtime state, policy controls, and operational visibility as defaults.',
        stats: [
          { value: 'sqlite', label: 'state' },
          { value: 'metrics', label: 'observability' },
        ],
        features: [
          'Prefer GitHub App where possible',
          'Enable durable runtime state',
          'Use remind / enforce policy mode as needed',
          'Keep replay available for incident debugging',
        ],
        cta: 'View Deployment Modes',
        highlight: true,
      },
    ],
  },
  zh: {
    label: '落地路径',
    title: '从试运行到生产接入。',
    subtitle: '更贴近实际的两步建议。',
    body:
      '这里不放虚构价格，而是根据仓库本身更真实的落地成熟度，先快速验证，再逐步补齐生产基线。',
    plans: [
      {
        badge: '起步',
        name: '试运行',
        price: '30 分钟',
        period: '/ 首轮验证',
        description:
          '适合先验证一个仓库与一条真实 Pull Request，再决定是否扩大使用范围。',
        stats: [
          { value: '1', label: '测试仓库' },
          { value: '1', label: '真实 PR' },
        ],
        features: [
          '配置 AI Provider 与模型',
          '设置 webhook URL 与 secret',
          '在评论区运行 /ai-review',
          '验证 /health 与平台健康端点',
        ],
        cta: '开始首轮验证',
        highlight: false,
      },
      {
        badge: '生产',
        name: '基线',
        price: '上线级',
        period: '/ 持续运行',
        description:
          '适合需要把持久化状态、策略控制与运维可见性作为默认工程基线的团队。',
        stats: [
          { value: 'sqlite', label: '状态后端' },
          { value: 'metrics', label: '可观测性' },
        ],
        features: [
          '优先使用 GitHub App 接入',
          '启用持久化运行时状态',
          '按需使用 remind / enforce 策略模式',
          '保留 replay 以便事故排障',
        ],
        cta: '查看接入方式',
        highlight: true,
      },
    ],
  },
} as const

export default function PricingSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="plans" className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="mb-16 text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">{copy.label}</span>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight mb-2">{copy.title}</h2>
          <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">{copy.subtitle}</h2>
          <p className="text-white/50 text-sm leading-relaxed max-w-[520px] mx-auto mt-6">{copy.body}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {copy.plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative border p-8 lg:p-10 flex flex-col gap-6 ${
                plan.highlight
                  ? 'border-[#0055fe]/50 bg-[#0055fe]/5'
                  : 'border-white/8 bg-[#080808]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`px-2.5 py-1 text-xs font-medium border ${
                    plan.highlight
                      ? 'bg-[#0055fe]/15 text-[#0055fe] border-[#0055fe]/30'
                      : 'bg-white/8 text-white/50 border-white/15'
                  }`}
                >
                  {plan.badge}
                </span>
                <h3 className="text-white/60 text-sm">{plan.name}</h3>
              </div>

              <div className="flex items-end gap-2">
                <span className="text-5xl font-bold text-white">{plan.price}</span>
                <div className="mb-1 flex flex-col">
                  <span className="text-white/40 text-sm">{plan.period}</span>
                </div>
              </div>

              <p className="text-white/50 text-sm leading-relaxed">{plan.description}</p>

              <div className="flex gap-6 pt-4 border-t border-white/8">
                {plan.stats.map((stat) => (
                  <div key={stat.label}>
                    <div className="text-2xl font-bold text-white">{stat.value}</div>
                    <div className="text-white/40 text-xs">{stat.label}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 flex-1">
                {plan.features.map((feature) => (
                  <div key={feature} className="flex items-center gap-2.5">
                    <svg
                      className="w-3.5 h-3.5 text-[#0055fe] flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-white/65 text-sm">{feature}</span>
                  </div>
                ))}
              </div>

              <Link
                href={plan.highlight ? '#deployment' : '#cta'}
                className={`inline-flex items-center justify-center gap-2 px-6 py-3.5 text-sm font-medium transition-colors ${
                  plan.highlight
                    ? 'bg-[#0055fe] text-white hover:bg-[#0044cc]'
                    : 'border border-white/20 text-white/70 hover:border-white/40 hover:text-white'
                }`}
              >
                {plan.cta}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
