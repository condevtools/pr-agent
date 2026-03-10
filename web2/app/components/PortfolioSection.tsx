'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Commands + Scenarios',
    title: 'The PR thread is not just output.',
    subtitle: 'It is also the operator interface.',
    body:
      'Auto review is useful as a default pass. Comment commands matter when you need targeted follow-up inside a live discussion.',
    cta: 'See Workflow',
    cards: [
      {
        name: '/ai-review',
        year: 'Primary Command',
        tags: ['PR / MR', 'Comment / Report'],
        href: '#faq',
        color: 'from-emerald-900/40 to-black',
      },
      {
        name: 'Interactive Commands',
        year: 'Discussion Thread',
        tags: ['ask / checks', 'generate_tests'],
        href: '#benefits',
        color: 'from-violet-900/40 to-black',
      },
      {
        name: 'Policy Guardrails',
        year: 'Repository Process',
        tags: ['Templates', 'CODEOWNERS'],
        href: '#deployment',
        color: 'from-sky-900/40 to-black',
      },
    ],
  },
  zh: {
    label: '命令与场景',
    title: 'PR 讨论区不只是输出面板。',
    subtitle: '它也是你的操作入口。',
    body:
      '自动评审适合作为默认首轮检查；评论命令则适合在真实讨论中做更有针对性的追加操作。',
    cta: '查看流程',
    cards: [
      {
        name: '/ai-review',
        year: '主命令',
        tags: ['PR / MR', 'Comment / Report'],
        href: '#faq',
        color: 'from-emerald-900/40 to-black',
      },
      {
        name: '交互命令',
        year: '评论区',
        tags: ['ask / checks', 'generate_tests'],
        href: '#benefits',
        color: 'from-violet-900/40 to-black',
      },
      {
        name: '策略护栏',
        year: '仓库流程',
        tags: ['Templates', 'CODEOWNERS'],
        href: '#deployment',
        color: 'from-sky-900/40 to-black',
      },
    ],
  },
} as const

export default function PortfolioSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="commands" className="bg-black py-24 lg:py-32">
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
            <div className="flex flex-col gap-4 lg:items-end">
              <p className="text-white/50 text-sm leading-relaxed max-w-[420px]">{copy.body}</p>
              <Link
                href="#process"
                className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors w-fit"
              >
                {copy.cta}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {copy.cards.map((project) => (
            <Link
              key={project.name}
              href={project.href}
              className="group relative bg-[#080808] border border-white/8 overflow-hidden aspect-[4/5] flex flex-col justify-between p-6 hover:border-white/20 transition-colors"
            >
              <div
                className={`absolute inset-0 bg-gradient-to-b ${project.color} opacity-60 group-hover:opacity-80 transition-opacity`}
              />

              <div className="relative z-10 flex items-start justify-between">
                <span className="text-white/40 text-sm">{project.year}</span>
                <svg
                  className="w-5 h-5 text-white/30 group-hover:text-white/70 transition-colors -rotate-45"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </div>

              <div className="relative z-10">
                <div className="flex flex-wrap gap-2 mb-3">
                  {project.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-1 border border-white/15 text-white/55 text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <h3 className="text-white text-xl font-semibold">{project.name}</h3>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
