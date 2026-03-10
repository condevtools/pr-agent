'use client'

import Link from 'next/link'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Fit Profiles',
    title: 'Built for teams that want AI review',
    subtitle: 'inside normal engineering flow.',
    body:
      'These are rollout profiles, not fictional customer quotes. They map the repository capabilities to the kinds of teams that actually need them.',
    cta: 'View Commands',
    cards: [
      {
        quote:
          'We need one review baseline across many repositories and want structured feedback to appear automatically when a PR opens.',
        name: 'Platform Engineering',
        role: 'Multi-repo governance',
        company: 'GitHub App + Policy',
      },
      {
        quote:
          'We want a conservative first rollout, using commands in comment threads before enabling more automatic behavior.',
        name: 'Application Team',
        role: 'Gradual adoption',
        company: 'Comment Commands',
      },
      {
        quote:
          'We need one toolchain that can support both GitHub and GitLab instead of maintaining separate review surfaces.',
        name: 'Mixed Platform Team',
        role: 'Cross-platform workflow',
        company: 'GitHub + GitLab',
      },
      {
        quote:
          'We care about workflows, templates, and CODEOWNERS changes as much as application code changes.',
        name: 'Repository Administrators',
        role: 'Process compliance',
        company: '.mr-agent.yml',
      },
      {
        quote:
          'After rollout, the real requirement is observability, because debugging webhook, provider, and runtime issues needs clear endpoints.',
        name: 'Ops / SRE',
        role: 'Production stability',
        company: 'Health + Metrics + Replay',
      },
      {
        quote:
          'We need the freedom to switch among providers depending on cost, quality, and deployment constraints.',
        name: 'AI Platform Lead',
        role: 'Provider governance',
        company: 'Multi-provider setup',
      },
    ],
  },
  zh: {
    label: '适用团队',
    title: '适合真正希望把 AI 评审',
    subtitle: '放进日常研发流程的团队。',
    body:
      '这些不是虚构的客户评价，而是把当前仓库能力映射到真实团队画像后的落地场景。',
    cta: '查看命令',
    cards: [
      {
        quote: '需要在多个仓库上统一 review 基线，并希望 PR 打开时就自动出现结构化反馈。',
        name: '平台工程团队',
        role: '多仓库治理',
        company: 'GitHub App + Policy',
      },
      {
        quote: '希望先保守上线，先在评论区用命令验证效果，再逐步打开更多自动化能力。',
        name: '应用研发团队',
        role: '渐进式接入',
        company: '评论命令',
      },
      {
        quote: '需要一套同时支持 GitHub 与 GitLab 的工具链，而不是维护两套独立评审入口。',
        name: '混合平台团队',
        role: '跨平台流程',
        company: 'GitHub + GitLab',
      },
      {
        quote: '除了业务代码变化，还同样关心 workflow、模板与 CODEOWNERS 这类流程资产。',
        name: '仓库管理员',
        role: '流程合规',
        company: '.mr-agent.yml',
      },
      {
        quote: '真正上线之后，关键要求是可观测性，因为 webhook、模型和运行时问题都需要明确的排障入口。',
        name: '运维 / SRE',
        role: '生产稳定性',
        company: 'Health + Metrics + Replay',
      },
      {
        quote: '需要根据成本、质量与部署约束，在不同模型提供商之间灵活切换。',
        name: 'AI 平台负责人',
        role: 'Provider 治理',
        company: '多模型配置',
      },
    ],
  },
} as const

export default function TestimonialsSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="scenarios" className="bg-black py-24 lg:py-32">
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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {copy.cards.map((item) => (
            <div
              key={item.name}
              className="bg-[#080808] border border-white/8 p-7 flex flex-col gap-5"
            >
              <svg className="w-8 h-8 text-[#0055fe]/40" fill="currentColor" viewBox="0 0 32 32">
                <path d="M9.352 4C4.456 7.456 1 13.12 1 19.36c0 5.088 3.072 8.064 6.624 8.064 3.36 0 5.856-2.688 5.856-5.856 0-3.168-2.208-5.472-5.088-5.472-.576 0-1.344.096-1.536.192.48-3.264 3.552-7.104 6.624-9.024L9.352 4zm16.512 0c-4.8 3.456-8.256 9.12-8.256 15.36 0 5.088 3.072 8.064 6.624 8.064 3.264 0 5.856-2.688 5.856-5.856 0-3.168-2.304-5.472-5.184-5.472-.576 0-1.248.096-1.44.192.48-3.264 3.456-7.104 6.528-9.024L25.864 4z" />
              </svg>

              <p className="text-white/65 text-sm leading-relaxed flex-1">&ldquo;{item.quote}&rdquo;</p>

              <div className="flex items-center gap-3 pt-4 border-t border-white/8">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-white/20 to-white/5 flex items-center justify-center">
                  <span className="text-white/60 text-xs font-medium">{item.name[0]}</span>
                </div>
                <div>
                  <div className="text-white text-sm font-medium">{item.name}</div>
                  <div className="text-white/40 text-xs">
                    {item.role} · {item.company}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
