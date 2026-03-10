'use client'

import HashLink from './HashLink'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Runtime Highlights',
    title: 'Reduce repeated AI work.',
    subtitle: 'Keep the review context that matters.',
    body:
      'This is not a single review prompt wrapped in a UI. It is a runtime built around triggers, dedupe, policy, metrics, and debugging loops.',
    cta: 'View Operations',
    cards: [
      {
        name: 'Incremental Review State',
        badge: 'Core',
        description:
          'Only reviews new commits since the previous run, reducing repeated comments and repeated AI work.',
        stats: ['New commits only', 'Lower repeated token cost'],
      },
      {
        name: 'Dedupe Protection',
        badge: 'Runtime',
        description:
          'Automatic triggers and comment commands both use dedupe windows to avoid duplicate executions after redelivery.',
        stats: ['5 min command window', 'Merged reports configurable'],
      },
      {
        name: 'Policy + Process Checks',
        badge: 'Governance',
        description:
          'Understands workflows, templates, CODEOWNERS, and CONTRIBUTING files, then emits process-aware feedback.',
        stats: ['remind / enforce', 'GitHub Check integration'],
      },
      {
        name: 'Observability + Replay',
        badge: 'Ops',
        description:
          'Exposes health checks, Prometheus metrics, and replay tooling for debugging real webhook traffic.',
        stats: ['GET /health /metrics', 'GitHub + GitLab replay'],
      },
    ],
  },
  zh: {
    label: '运行亮点',
    title: '减少重复的 AI 工作量。',
    subtitle: '保留真正有价值的评审上下文。',
    body:
      '这不是把一个评审提示词包进页面，而是一套围绕触发、去重、策略、指标与调试构建的运行机制。',
    cta: '查看运维',
    cards: [
      {
        name: '增量评审状态',
        badge: '核心',
        description: '只处理上次评审后的新增提交，减少重复评论，也降低重复 AI 调用成本。',
        stats: ['仅覆盖新增提交', '降低重复 token 消耗'],
      },
      {
        name: '去重保护',
        badge: '运行时',
        description: '自动触发与评论命令都带去重窗口，避免 webhook 重投时重复执行。',
        stats: ['命令 5 分钟窗口', '合并报告可单独配置'],
      },
      {
        name: '策略与流程检查',
        badge: '治理',
        description: '识别 workflow、模板、CODEOWNERS 与 CONTRIBUTING 文件，并输出流程感知反馈。',
        stats: ['支持 remind / enforce', '可接 GitHub Check'],
      },
      {
        name: '可观测与回放',
        badge: '运维',
        description: '通过健康检查、Prometheus 指标与 replay 工具支持真实 webhook 流量排障。',
        stats: ['GET /health /metrics', '支持 GitHub + GitLab 回放'],
      },
    ],
  },
} as const

export default function ResultsSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]
  const items = [...copy.cards, ...copy.cards]

  return (
    <section id="runtime-highlights" className="bg-black py-20 md:py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1440px] mx-auto px-5 sm:px-6 lg:px-10 mb-16">
        <div data-gsap="reveal" className="inline-flex items-center gap-2 mb-6">
          <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
          </div>
          <span className="text-white/50 text-sm">{copy.label}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
          <div data-gsap="reveal">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight">{copy.title}</h2>
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight">{copy.subtitle}</h2>
          </div>
          <div className="flex flex-col gap-4 lg:items-end">
            <p data-gsap="reveal" className="text-white/50 text-sm leading-relaxed max-w-[420px]">{copy.body}</p>
            <HashLink
              href="#operations"
              data-gsap="reveal"
              className="inline-flex items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
            >
              {copy.cta}
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </HashLink>
          </div>
        </div>
      </div>

      <div className="relative">
        <div data-gsap="cards" className="flex animate-marquee gap-6" style={{ width: 'max-content' }}>
          {items.map((item, idx) => (
            <div
              key={`${item.name}-${idx}`}
              className="flex-shrink-0 w-[280px] sm:w-80 bg-[#080808] border border-white/8 p-6 flex flex-col gap-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-white font-semibold text-base">{item.name}</h3>
                <span className="px-2 py-0.5 bg-[#0055fe]/15 text-[#0055fe] text-xs font-medium border border-[#0055fe]/30">
                  {item.badge}
                </span>
              </div>
              <p className="text-white/45 text-sm leading-relaxed">{item.description}</p>
              <div className="flex flex-col gap-2 pt-2 border-t border-white/8">
                {item.stats.map((stat) => (
                  <div key={stat} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#0055fe]" />
                    <span className="text-white/70 text-sm font-medium">{stat}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-black to-transparent pointer-events-none" />
        <div className="absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-black to-transparent pointer-events-none" />
      </div>
    </section>
  )
}
