'use client'

import HashLink from './HashLink'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Workflow',
    title: 'From webhook setup',
    subtitle: 'to observable runtime.',
    body:
      'If you only want a fast validation, start with one real PR. If you want production rollout, keep going until policy, runtime state, and monitoring are in place.',
    stages: [
      {
        number: 'Stage 1',
        title: 'Platform Setup',
        description:
          'Choose GitHub App, plain GitHub webhook, or GitLab webhook first, then configure secrets, webhook URLs, and your AI provider.',
        features: ['GitHub / GitLab intake', 'OpenAI / Claude / Gemini'],
      },
      {
        number: 'Stage 2',
        title: 'Review Triggers',
        description:
          'Run automatically on PR or MR lifecycle events, or trigger targeted work from the comment thread with commands.',
        features: ['Automatic + manual triggers', 'Comment / report modes'],
      },
      {
        number: 'Stage 3',
        title: 'Observe + Tune',
        description:
          'Use /health, /metrics, platform health endpoints, and replay tooling to keep the runtime observable and debuggable.',
        features: ['Prometheus metrics', 'Health checks + replay'],
        cta: 'See Deployment Baseline',
      },
    ],
  },
  zh: {
    label: '接入流程',
    title: '从 webhook 接入',
    subtitle: '到可观测运行。',
    body:
      '如果只是快速验证，可以先跑一条真实 PR；如果要生产接入，就继续补齐策略、运行时状态与监控。',
    stages: [
      {
        number: '阶段 1',
        title: '平台接入',
        description:
          '先选择 GitHub App、普通 GitHub Webhook 或 GitLab Webhook，再配置密钥、Webhook 地址和 AI Provider。',
        features: ['GitHub / GitLab 接入', 'OpenAI / Claude / Gemini'],
      },
      {
        number: '阶段 2',
        title: '触发评审',
        description:
          '在 PR/MR 生命周期事件上自动运行，也可以在评论区通过命令执行更有针对性的操作。',
        features: ['自动 + 手动触发', 'Comment / Report 双模式'],
      },
      {
        number: '阶段 3',
        title: '观测与优化',
        description:
          '结合 /health、/metrics、平台健康端点与 replay 工具，让运行时保持可观测、可调试。',
        features: ['Prometheus 指标', '健康检查 + 回放'],
        cta: '查看部署基线',
      },
    ],
  },
} as const

export default function ProcessSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="process" className="bg-black py-20 md:py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-5 sm:px-6 lg:px-10">
        <div className="mb-16">
          <div data-gsap="reveal" className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">{copy.label}</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div data-gsap="reveal">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight">{copy.title}</h2>
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight">{copy.subtitle}</h2>
            </div>
            <p data-gsap="reveal" className="text-white/50 text-sm leading-relaxed max-w-[420px]">{copy.body}</p>
          </div>
        </div>

        <div data-gsap="cards" className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/8">
          {copy.stages.map((stage, idx) => (
            <div
              key={stage.number}
              className="bg-black p-6 sm:p-8 lg:p-10 flex flex-col gap-6 border border-white/8"
              style={{ borderLeft: idx > 0 ? 'none' : undefined }}
            >
              <div className="flex flex-col gap-2">
                <span className="text-white/35 text-xs font-medium tracking-wider uppercase">
                  {stage.number}
                </span>
                <h3 className="text-white text-xl font-semibold">{stage.title}</h3>
              </div>

              <p className="text-white/50 text-sm leading-relaxed flex-1">{stage.description}</p>

              <div className="flex flex-col gap-2.5 pt-4 border-t border-white/8">
                {stage.features.map((feature) => (
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

              {'cta' in stage && stage.cta ? (
                <HashLink
                  href="#deployment"
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
                >
                  {stage.cta}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </HashLink>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
