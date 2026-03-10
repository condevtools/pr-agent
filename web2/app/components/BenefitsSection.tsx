'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const TAGS = {
  en: [
    'GitHub App',
    'GitHub Webhook',
    'GitLab Webhook',
    'OpenAI Compatible',
    'Claude',
    'Gemini',
    'SQLite',
    'Prometheus',
    'Replay',
    '.mr-agent.yml',
  ],
  zh: [
    'GitHub App',
    'GitHub Webhook',
    'GitLab Webhook',
    'OpenAI 兼容接口',
    'Claude',
    'Gemini',
    'SQLite',
    'Prometheus',
    '回放',
    '.mr-agent.yml',
  ],
} as const

const COPY = {
  en: {
    label: 'Product Focus',
    title: 'Review output is only part of it.',
    subtitle: 'Commands, policy, and runtime controls matter too.',
    cta: 'View Scenarios',
    mainTitle: 'The PR thread becomes the control surface.',
    mainBody:
      'Run /ai-review, /ask, /checks, /generate_tests, /describe, /changelog, /improve, and more directly inside code review discussions.',
    mainPrimary: 'Command Scenarios',
    mainSecondary: 'Read FAQ',
    cards: [
      {
        title: 'Incremental Review',
        badge: 'Core',
        desc: 'Only reviews the new commit range so old comments do not get replayed forever.',
      },
      {
        title: 'Auto-labeling',
        badge: null,
        desc: 'Can infer bugfix, feature, refactor, docs, and security labels from diff content.',
      },
      {
        title: 'Process Compliance',
        badge: 'GitHub',
        desc: 'Pre-checks issue and pull request flows against repository templates and process files.',
      },
      {
        title: 'Feedback Signals',
        badge: 'Learning',
        desc: 'Stores reviewer preference signals through feedback commands and review-thread state.',
      },
    ],
  },
  zh: {
    label: '产品侧重点',
    title: '评审输出只是其中一部分。',
    subtitle: '命令、策略和运行时控制同样重要。',
    cta: '查看场景',
    mainTitle: 'PR 评论区本身就是操作面板。',
    mainBody:
      '可以直接在评审讨论中运行 /ai-review、/ask、/checks、/generate_tests、/describe、/changelog、/improve 等命令。',
    mainPrimary: '命令场景',
    mainSecondary: '阅读 FAQ',
    cards: [
      {
        title: '增量评审',
        badge: '核心',
        desc: '只评审新增提交范围，避免旧评论反复被重新生成。',
      },
      {
        title: '自动标签',
        badge: null,
        desc: '可根据 diff 内容推断 bugfix、feature、refactor、docs、security 等标签。',
      },
      {
        title: '流程合规',
        badge: 'GitHub',
        desc: '对 Issue 与 Pull Request 流程执行模板和流程文件预检查。',
      },
      {
        title: '反馈信号',
        badge: '学习',
        desc: '通过反馈命令和 review thread 状态记录审阅偏好信号。',
      },
    ],
  },
} as const

export default function BenefitsSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]
  const tags = TAGS[locale]

  return (
    <section id="benefits" className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="inline-flex items-center gap-2 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
          <span className="text-white/50 text-sm">{copy.label}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
          <div className="flex flex-col gap-8">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">{copy.title}</h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white/40 leading-tight mt-1">
                {copy.subtitle}
              </h2>
            </div>

            <div className="flex flex-wrap gap-2.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="px-4 py-2 border border-white/12 text-white/60 text-sm hover:border-white/25 hover:text-white/80 transition-colors cursor-default"
                >
                  {tag}
                </span>
              ))}
            </div>

            <Link
              href="#commands"
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit mt-2"
            >
              {copy.cta}
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>

          <div className="flex flex-col gap-4">
            <div className="bg-[#080808] border border-white/8 p-8 flex flex-col gap-4">
              <h3 className="text-white font-semibold text-lg">{copy.mainTitle}</h3>
              <p className="text-white/50 text-sm leading-relaxed">{copy.mainBody}</p>
              <div className="flex gap-3 pt-2">
                <Link
                  href="#commands"
                  className="px-4 py-2 bg-[#0055fe] text-white text-xs font-medium hover:bg-[#0044cc] transition-colors"
                >
                  {copy.mainPrimary}
                </Link>
                <Link
                  href="#faq"
                  className="px-4 py-2 border border-white/15 text-white/60 text-xs hover:border-white/30 hover:text-white/80 transition-colors"
                >
                  {copy.mainSecondary}
                </Link>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {copy.cards.map((card) => (
                <div key={card.title} className="bg-[#080808] border border-white/8 p-5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium">{card.title}</span>
                    {card.badge && (
                      <span className="px-1.5 py-0.5 bg-white/8 text-white/50 text-xs border border-white/10">
                        {card.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-white/45 text-xs leading-relaxed">{card.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
