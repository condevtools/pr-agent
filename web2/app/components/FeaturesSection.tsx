'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Capabilities',
    title: 'What PR Agent Handles',
    subtitle: 'Features mapped to the real repository.',
    body:
      'The homepage copy is now tied to product behavior already present in the repository, not generic agency placeholders.',
    cta: 'View Commands',
    features: [
      {
        title: 'Automatic PR/MR Review',
        badge: 'Core',
        subtitle: 'Review Triggers',
        description:
          'Runs on opened, edited, synchronize, and merged events so the first review pass does not depend on manual timing.',
      },
      {
        title: 'Inline Comments + Reports',
        badge: 'Core',
        subtitle: 'Comment + Report',
        description:
          'Supports comment and report modes, with GitHub Suggested Changes where appropriate.',
      },
      {
        title: 'Interactive Command Surface',
        badge: 'Commands',
        subtitle: 'Comment Thread',
        description:
          'Run /ask, /checks, /generate_tests, /describe, and more directly inside PR or MR discussions.',
      },
      {
        title: 'Policy Guardrails',
        badge: 'Governance',
        subtitle: 'Repository Process',
        description:
          'Understands templates, workflows, CODEOWNERS, and CONTRIBUTING changes, then emits process-aware feedback.',
      },
      {
        title: 'Multi-provider AI Support',
        badge: 'Compatible',
        subtitle: 'Provider Choice',
        description:
          'Works with OpenAI, compatible APIs, Claude, and Gemini depending on deployment needs.',
      },
      {
        title: 'Operations Endpoints',
        badge: 'Ops',
        subtitle: 'Health + Metrics',
        description:
          'Exposes health checks, Prometheus metrics, and replay endpoints for debugging production traffic.',
      },
    ],
  },
  zh: {
    label: '核心能力',
    title: 'PR Agent 能处理什么',
    subtitle: '把首页文案对齐到仓库里的真实能力。',
    body:
      '现在首页的每一段描述都回到仓库已实现的产品行为，而不是通用 agency 模板里的占位文案。',
    cta: '查看命令',
    features: [
      {
        title: '自动 PR/MR 评审',
        badge: '核心',
        subtitle: '评审触发',
        description:
          '在 opened、edited、synchronize、merged 等事件上自动运行，不再依赖人工手动触发首轮评审。',
      },
      {
        title: '行内评论与汇总报告',
        badge: '核心',
        subtitle: 'Comment + Report',
        description:
          '同时支持 comment 与 report 模式，并在合适场景下输出 GitHub Suggested Changes。',
      },
      {
        title: '交互命令面板',
        badge: '命令',
        subtitle: '评论区',
        description:
          '可直接在 PR/MR 讨论区运行 /ask、/checks、/generate_tests、/describe 等命令。',
      },
      {
        title: '策略护栏',
        badge: '治理',
        subtitle: '仓库流程',
        description:
          '理解模板、workflow、CODEOWNERS 与 CONTRIBUTING 变更，并输出流程感知反馈。',
      },
      {
        title: '多模型支持',
        badge: '兼容',
        subtitle: 'Provider 选择',
        description:
          '可按部署需求切换 OpenAI、兼容接口、Claude 与 Gemini 等模型提供商。',
      },
      {
        title: '运维端点',
        badge: '运维',
        subtitle: '健康与指标',
        description:
          '提供健康检查、Prometheus 指标与 replay 端点，用于生产环境调试与观测。',
      },
    ],
  },
} as const

export default function FeaturesSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="features" className="bg-black py-24 lg:py-32">
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
                href="#commands"
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/8">
          {copy.features.map((feature) => (
            <Link
              key={feature.title}
              href="#cta"
              className="group bg-black p-8 flex flex-col gap-4 border border-white/8 hover:bg-[#080808] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-white font-semibold text-base leading-snug">{feature.title}</h3>
                <span
                  className={`flex-shrink-0 px-2 py-0.5 text-xs font-medium border ${
                    feature.badge === 'Core' || feature.badge === '核心'
                      ? 'bg-[#0055fe]/15 text-[#0055fe] border-[#0055fe]/30'
                      : 'bg-white/8 text-white/60 border-white/15'
                  }`}
                >
                  {feature.badge}
                </span>
              </div>
              <p className="text-white/45 text-xs font-medium uppercase tracking-wider">
                {feature.subtitle}
              </p>
              <p className="text-white/50 text-sm leading-relaxed mt-auto">{feature.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
