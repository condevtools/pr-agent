'use client'

import { useState } from 'react'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'FAQ',
    title: 'Common Questions',
    body:
      'These answers are aligned with the current repository README and the sibling web project, not invented marketing promises.',
    items: [
      {
        question: 'Which platforms and integration modes are supported?',
        answer:
          'The repository currently supports GitHub App, plain GitHub Webhook, and GitLab Webhook. GitHub App is the recommended path because it has the cleanest permissions model and the broadest tested coverage.',
      },
      {
        question: 'When does automatic review run?',
        answer:
          'Automatic review can run on opened, edited, synchronize, and merged PR or MR events. You can also trigger the same flow manually with /ai-review inside the comment thread.',
      },
      {
        question: 'Which AI providers are supported?',
        answer:
          'The project supports OpenAI, OpenAI-compatible APIs, Anthropic Claude, and Google Gemini. The key practical difference is that the provider can be switched through environment configuration.',
      },
      {
        question: 'How do policy checks and branch protection fit in?',
        answer:
          'The .mr-agent.yml file controls review switches, auto-labeling, and policy behavior. On GitHub, you can also connect policy output to a GitHub Check and use it with branch protection.',
      },
      {
        question: 'What runtime state backend is recommended for production?',
        answer:
          'For single-instance production deployment, the repository recommends sqlite as the durable runtime state backend. That keeps dedupe, review state, and related runtime signals more stable than memory only.',
      },
      {
        question: 'How do I debug webhook or runtime problems?',
        answer:
          'Start with /health, /health?deep=true, /github/health, /gitlab/health, and /metrics. If replay is enabled, you can also inspect stored events and replay them through the provided endpoints.',
      },
    ],
  },
  zh: {
    label: '常见问题',
    title: '常见问题',
    body:
      '这些回答都直接对齐当前仓库 README 与 sibling web 项目的内容，而不是额外虚构的营销承诺。',
    items: [
      {
        question: '支持哪些平台和接入方式？',
        answer:
          '当前仓库支持 GitHub App、普通 GitHub Webhook 与 GitLab Webhook。GitHub App 是更推荐的接入方式，因为权限模型更清晰，测试覆盖也更完整。',
      },
      {
        question: '自动评审会在什么时机触发？',
        answer:
          '自动评审可在 opened、edited、synchronize、merged 等 PR/MR 事件上运行；同时也可以在评论区通过 /ai-review 手动触发同样的流程。',
      },
      {
        question: '支持哪些 AI Provider？',
        answer:
          '项目支持 OpenAI、OpenAI 兼容接口、Anthropic Claude 与 Google Gemini。实际使用时最关键的是可以通过环境变量切换不同 Provider。',
      },
      {
        question: '策略检查和 Branch Protection 如何配合？',
        answer:
          '.mr-agent.yml 可控制评审开关、自动标签与策略行为；在 GitHub 场景下，还可以把策略输出接到 GitHub Check，再配合 Branch Protection 使用。',
      },
      {
        question: '生产环境推荐什么运行时状态后端？',
        answer:
          '对于单实例生产环境，仓库推荐使用 sqlite 作为持久化运行时状态后端。这样比单纯依赖内存更适合保存去重、评审状态等运行时信息。',
      },
      {
        question: '如何排查 webhook 或运行时问题？',
        answer:
          '先检查 /health、/health?deep=true、/github/health、/gitlab/health 与 /metrics；如果开启了 replay，还可以查看已存储事件并进行回放调试。',
      },
    ],
  },
} as const

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="faq" className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
          <div className="flex flex-col gap-6">
            <div className="inline-flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
              <span className="text-white/50 text-sm">{copy.label}</span>
            </div>
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">{copy.title}</h2>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[420px]">{copy.body}</p>
          </div>

          <div className="flex flex-col divide-y divide-white/8">
            {copy.items.map((faq, idx) => (
              <div key={faq.question}>
                <button
                  className="w-full flex items-start justify-between gap-4 py-5 text-left group"
                  onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
                >
                  <span
                    className={`text-sm font-medium transition-colors ${
                      openIndex === idx ? 'text-white' : 'text-white/70 group-hover:text-white'
                    }`}
                  >
                    {faq.question}
                  </span>
                  <span
                    className={`flex-shrink-0 w-5 h-5 flex items-center justify-center border border-white/15 transition-all ${
                      openIndex === idx ? 'border-[#0055fe]/50 bg-[#0055fe]/10 rotate-45' : ''
                    }`}
                  >
                    <svg
                      className={`w-2.5 h-2.5 transition-colors ${
                        openIndex === idx ? 'text-[#0055fe]' : 'text-white/40'
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                    </svg>
                  </span>
                </button>
                {openIndex === idx ? (
                  <div className="pb-5">
                    <p className="text-white/50 text-sm leading-relaxed">{faq.answer}</p>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
